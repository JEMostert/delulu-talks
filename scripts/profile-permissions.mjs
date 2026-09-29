import { lstat, mkdtemp, mkdir, writeFile, readFile, unlink, rmdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const index = args.indexOf("--profile");
if (!args.includes("--run") || index < 0 || !args[index + 1]) {
  console.error("Usage: node scripts/profile-permissions.mjs --run --profile /explicit/profile/directory");
  process.exit(2);
}
const profile = resolve(args[index + 1]);
const salt = randomUUID();
const hash = (value) => createHash("sha256").update(salt + String(value)).digest("hex").slice(0, 16);
const failure = (reason) => ({ status: "unknown", errorCode: reason?.code ?? "PROBE_FAILED" });
const results = [];

async function observe(role, path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { role, status: "symlink-not-followed", pathHash: hash(path) };
    if (process.platform !== "win32") {
      const mode = info.mode & 0o777;
      return { role, status: "observed", pathHash: hash(path),
        type: info.isDirectory() ? "directory" : "file", mode: mode.toString(8).padStart(3, "0"),
        ownerMatchesProcess: typeof process.getuid === "function" ? info.uid === process.getuid() : null,
        otherUsersCanRead: !!(mode & 0o044), otherUsersCanWrite: !!(mode & 0o022),
        limitation: "POSIX mode bits do not enumerate extended ACLs, sandbox permissions or filesystem policy" };
    }
    const program = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:DELULU_PERMISSION_PROBE_TARGET
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$entries = @($acl.Access | ForEach-Object {
  $sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  @{ sid=$sid; rights=[int]$_.FileSystemRights; type=$_.AccessControlType.ToString(); inherited=$_.IsInherited }
})
@{ ownerMatchesProcess=($owner -eq $current); entries=$entries } | ConvertTo-Json -Depth 5 -Compress
`;
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], {
      timeout: 8000, windowsHide: true, maxBuffer: 256 * 1024,
      env: { ...process.env, DELULU_PERMISSION_PROBE_TARGET: path },
    });
    const acl = JSON.parse(stdout.trim());
    const broad = new Set(["S-1-1-0", "S-1-5-11", "S-1-5-32-545"]);
    const entries = Array.isArray(acl.entries) ? acl.entries : [];
    return { role, status: "observed", pathHash: hash(path), ownerMatchesProcess: acl.ownerMatchesProcess,
      acl: entries.map((entry) => ({ identityHash: hash(entry.sid), rights: entry.rights, type: entry.type, inherited: entry.inherited,
        broadGroup: broad.has(entry.sid) })),
      broadWriteAllowPresent: entries.some((entry) => broad.has(entry.sid) && entry.type === "Allow" && (entry.rights & (2 | 4 | 16 | 256 | 65536 | 262144 | 524288))),
      limitation: "ACL entries are observations, not an effective-access calculation; deny rules/group membership can change access" };
  } catch (reason) {
    return { role, pathHash: hash(path), ...failure(reason) };
  }
}

async function ownedProbe(role, parent) {
  let directory;
  let path;
  const result = { role, status: "unknown" };
  try {
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw Object.assign(new Error(), { code: "UNSAFE_PARENT" });
    directory = join(parent, `.delulu-permission-probe-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    path = join(directory, "probe.txt");
    const payload = `synthetic permission probe ${randomUUID()}`;
    await writeFile(path, payload, { flag: "wx", mode: 0o600 });
    result.roundTrip = await readFile(path, "utf8") === payload;
    result.directory = await observe(`${role}-directory`, directory);
    result.file = await observe(`${role}-file`, path);
    result.status = result.roundTrip ? "observed" : "round-trip-mismatch";
  } catch (reason) {
    Object.assign(result, failure(reason));
  } finally {
    // Remove only the exact newly created file/directory. Never recurse through
    // user data or delete another file even if something changed during a probe.
    try { if (path) await unlink(path); } catch (reason) { if (reason.code !== "ENOENT") result.cleanupErrorCode = reason.code; }
    try { if (directory) await rmdir(directory); } catch (reason) { if (reason.code !== "ENOENT") result.cleanupErrorCode = reason.code; }
  }
  return result;
}

results.push(await observe("application-data", profile));
for (const [role, relative] of [["settings", "settings.json"], ["history", "history.json"], ["audio-cache", "audio-cache"], ["model-cache", "models"]]) {
  results.push(await observe(role, join(profile, relative)));
}
results.push(await ownedProbe("application-data-write", profile));
let temporary;
try {
  temporary = await mkdtemp(join(tmpdir(), "delulu-permissions-"));
  results.push(await observe("os-temporary-directory", temporary));
  results.push(await ownedProbe("temporary-file-write", temporary));
} catch (reason) {
  results.push({ role: "temporary-file-write", ...failure(reason) });
} finally {
  if (temporary) {
    try { await rmdir(temporary); }
    catch (reason) { results.push({ role: "temporary-cleanup", ...failure(reason) }); }
  }
}
console.log(JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  node: process.versions.node, results,
  limitations: ["Only this actual machine was probed", "No settings/history/audio contents read", "Identifiers are salted per run; reports cannot correlate private paths/users across runs", "No inference, delivery or OS permission grant tested", "Missing paths and unavailable ACL tools are unknown, not successful checks", "Probe files are synthetic; no permissions are changed or auto-repaired"] }, null, 2));
if (results.some((result) => result.status === "unknown" || result.cleanupErrorCode)) process.exitCode = 1;
