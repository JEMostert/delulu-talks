#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  const value = args[index + 1]; args.splice(index, 2); return value;
}
function flag(name) { const index = args.indexOf(name); if (index === -1) return false; args.splice(index, 1); return true; }

async function main() {
  const json = flag("--json");
  const connectionPath = option("--connection") ?? process.env.DELULU_CONNECTION_FILE;
  const suppliedToken = option("--token") ?? process.env.DELULU_API_TOKEN;
  const output = option("--output");
  const preset = option("--preset") ?? "polish";
  const command = args.shift() ?? "help";
  if (command === "help" || command === "--help") {
    console.log(`delulu <command> [--json] [--connection PATH] [--output PATH]\n\nstatus | diagnostics | profiles | profile ID | profile global\nhistory | export ID | transcribe FILE | batch FILE...\nrewrite TEXT | rewrite --stdin [--preset polish|concise|structured|prompt]\nevents | integrations | revoke ID\n\nEnable Local automation in Settings first. --output never overwrites a file.\nUse DELULU_API_TOKEN for scoped tokens; passing --token exposes it in process arguments.\nNative transcription uses the running app's pinned R2T2 runtime and active profile.`);
    return;
  }
  const appData = process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : process.platform === "win32" ? process.env.APPDATA : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (!appData && !connectionPath) throw new Error("Set --connection to the desktop app's connection.json");
  const roots = process.env.DELULU_USER_DATA_DIR ? [process.env.DELULU_USER_DATA_DIR] : [join(appData ?? "", "Delulu Talks"), join(appData ?? "", "Delulu Talks Dev")];
  let connection;
  for (const path of connectionPath ? [resolve(connectionPath)] : roots.map((root) => join(root, "automation", "connection.json"))) {
    try { connection = JSON.parse(await readFile(path, "utf8")); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!connection) throw new Error("No active local API connection. Enable Local automation in the running desktop app.");
  if (connection.schemaVersion !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.url)) throw new Error("Invalid loopback connection file");
  const token = suppliedToken ?? connection.token;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) throw new Error("Invalid integration token");
  async function request(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(`${connection.url}/v1/${path}`, {
      method, redirect: "error", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(path === "transcribe" || path === "rewrite" ? 4 * 60 * 60 * 1000 : 30_000),
    });
    if (!response.ok) { const value = await response.json(); throw new Error(value.error ?? `HTTP ${response.status}`); }
    return response;
  }
  let result;
  if (command === "events") {
    if (output) throw new Error("events streams to stdout; redirect it explicitly if needed");
    const response = await request("events");
    for await (const chunk of response.body) {
      if (!process.stdout.write(Buffer.from(chunk))) await new Promise((done) => process.stdout.once("drain", done));
    }
    return;
  } else if (["status", "diagnostics", "profiles", "history", "integrations"].includes(command)) result = await (await request(command)).json();
  else if (command === "profile") {
    if (!args[0]) throw new Error("Specify a profile ID or global");
    result = await (await request("profiles/activate", { id: args[0] === "global" ? null : args[0] })).json();
  } else if (command === "transcribe" || command === "batch") {
    if (!args.length) throw new Error("Specify one or more source files");
    if (command === "transcribe" && args.length !== 1) throw new Error("Use batch for multiple files");
    if (args.length > 100) throw new Error("Batch limit is 100 files");
    const rows = [];
    for (const path of args) {
      try { rows.push({ path: resolve(path), record: await (await request("transcribe", { path: resolve(path) })).json() }); }
      catch (error) { if (command === "transcribe") throw error; rows.push({ path: resolve(path), error: error.message }); process.exitCode = 1; }
    }
    result = command === "transcribe" ? rows[0].record : rows;
  } else if (command === "export") {
    if (!args[0]) throw new Error("Specify a transcript ID");
    result = await (await request(`history/${encodeURIComponent(args[0])}${json ? "" : "?format=txt"}`)).json();
  } else if (command === "rewrite") {
    const stdin = flag("--stdin");
    let text = args.join(" ");
    if (stdin) {
      const chunks = []; let length = 0;
      for await (const chunk of process.stdin) { length += chunk.length; if (length > 200_000) throw new Error("Input exceeds 200 KB"); chunks.push(chunk); }
      text = Buffer.concat(chunks).toString("utf8");
    }
    result = await (await request("rewrite", { text, preset })).json();
  } else if (command === "revoke") {
    if (!args[0]) throw new Error("Specify an integration ID");
    result = await (await request(`integrations/${encodeURIComponent(args[0])}`, undefined, "DELETE")).json();
  } else throw new Error(`Unknown command: ${command}. Use help.`);
  const rendered = json ? JSON.stringify(result, null, 2) : typeof result?.text === "string" ? result.text : Array.isArray(result) ? result.map((item) => item.record?.text ?? (item.error ? `${item.path}: ${item.error}` : typeof item === "object" ? JSON.stringify(item) : String(item))).join("\n") : JSON.stringify(result, null, 2);
  if (output) await writeFile(resolve(output), `${rendered}\n`, { flag: "wx", mode: 0o600 });
  else console.log(rendered);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
