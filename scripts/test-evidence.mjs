import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const EVIDENCE_KINDS = [
  "fixture-only",
  "mocked",
  "native-inference",
  "manual-desktop",
];
const reportDirectory = resolve("artifacts/verification");

function revision() {
  return {
    sha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

function requiredText(value, fields, context) {
  for (const field of fields) {
    if (typeof value?.[field] !== "string" || !value[field].trim())
      throw new Error(`${context} requires ${field}`);
  }
}

function nativeMetadata(path) {
  if (!path)
    throw new Error("Native inference requires --metadata <file.json>");
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  requiredText(
    metadata,
    ["hardware", "backend", "modelRevision", "runtimeRevision"],
    "Native metadata",
  );
  if (metadata.modelId !== "r2t2")
    throw new Error("Native evidence must identify the R2T2 speech model");
  if (!["mlx", "cuda-vllm", "cuda-transformers"].includes(metadata.backend))
    throw new Error("Native metadata requires a supported speech backend");
  return metadata;
}

export function planSuite(suite, input = []) {
  const args = [...input];
  if (args[0] === "--") args.shift();
  const metadataPath = option(args, "--metadata");
  if (args[0] === "--") args.shift();
  if (["unit", "python", "browser"].includes(suite) && args.length)
    throw new Error(
      `${suite} reporting requires the complete suite without filters/help/list options`,
    );
  let metadata = null;
  let command;
  let kinds;
  let scope;
  switch (suite) {
    case "unit":
      command = ["bun", "test", ...args];
      kinds = ["fixture-only", "mocked"];
      scope =
        "Deterministic logic, temporary files/processes, mocked Electron and inference adapters; no downloaded models.";
      break;
    case "python":
      command = [
        "python3",
        "-m",
        "unittest",
        "discover",
        "-s",
        "electron/python",
        "-p",
        "*_test.py",
        ...args,
      ];
      kinds = ["mocked"];
      scope =
        "Python adapter contracts with fake model/framework modules; no GPU inference.";
      break;
    case "browser":
      command = ["bunx", "--no-install", "playwright", "test", ...args];
      kinds = ["mocked"];
      scope =
        "Real Chromium and synthetic microphone capture, with preview/mock backend IPC; no native model or system paste.";
      break;
    case "data-deletion":
      if (args.length)
        throw new Error(
          "Data deletion reporting requires the complete fixture suite",
        );
      command = ["node", "scripts/data-deletion-smoke.mjs"];
      kinds = ["fixture-only"];
      scope =
        "Real isolated Electron deletion/reset IPC, durable and session references, delayed delivery races; clipboard captured and harmless injector. No native inference or manual delivery.";
      break;
    case "desktop": {
      const native = args.length > 0;
      if (native && args[0].startsWith("-"))
        throw new Error(
          "Desktop native checks require a runtime directory first",
        );
      if (
        args.slice(1).some((arg) => !["--writing", "--lifecycle"].includes(arg))
      )
        throw new Error(
          "Desktop reporting only accepts a runtime directory, --writing and --lifecycle",
        );
      if (native) metadata = nativeMetadata(metadataPath);
      command = ["node", "scripts/desktop-smoke.mjs", ...args];
      kinds = native ? ["fixture-only", "native-inference"] : ["fixture-only"];
      scope = native
        ? "Real Electron IPC and cached-model transcription of test-audio.m4a; optional lifecycle/rewriting flags. No manual focus/delivery verification."
        : "Real isolated Electron, preload/IPC and settings/history fixtures. No speech inference, real microphone or manual focus/delivery verification.";
      break;
    }
    case "package-resources":
      if (
        metadataPath ||
        args.length !== 2 ||
        args[0].startsWith("-") ||
        !["linux", "mac", "win"].includes(args[1])
      )
        throw new Error(
          "Package resource reporting requires an unpacked directory and linux/mac/win; no runtime or filters",
        );
      command = ["bun", "scripts/package-resources.mjs", ...args];
      kinds = ["fixture-only"];
      scope =
        "Actual unpacked resource hashes and configured native icon payloads. No application launch, native model inference or manual desktop verification.";
      break;
    case "mac-package":
      if (args.length > 1 || args.some((arg) => arg.startsWith("-")))
        throw new Error(
          "Package reporting accepts one app path without a runtime; use desktop/native for inference",
        );
      command = ["node", "scripts/mac-package-smoke.mjs", ...args];
      kinds = ["fixture-only"];
      scope =
        "Actual Mac package replacement/relaunch and persisted fixtures, without a cached runtime. No inference or manual observation.";
      break;
    case "native": {
      const python = option(args, "--python");
      if (args[0] === "--") args.shift();
      if (!python)
        throw new Error("Native checks require --python <runtime interpreter>");
      if (!args.includes("--cache"))
        throw new Error("Native checks require --cache <pre-downloaded cache>");
      const cache = option(args, "--cache");
      if (!cache || args.some((arg) => arg !== "--magic") || args.length > 1)
        throw new Error(
          "Native reporting only accepts --python, --cache, --metadata and optional --magic",
        );
      metadata = nativeMetadata(metadataPath);
      command = [python, "scripts/runtime-smoke.py", "--cache", cache, ...args];
      kinds = ["native-inference"];
      scope =
        "Opt-in cached-model inference on test-audio.m4a; optional rewriting. No manual desktop delivery or accuracy measurement.";
      break;
    }
    default:
      throw new Error(`Unknown suite: ${suite}`);
  }
  if (metadataPath && !metadata)
    throw new Error("--metadata is only valid for a native-inference run");
  return { command, kinds, scope, metadata };
}

export function validateManual(record, sha) {
  if (record.kind !== "manual-desktop" || record.sha !== sha)
    throw new Error(
      "Manual record must identify manual-desktop and the current full head SHA",
    );
  requiredText(
    record,
    ["observer", "observedAt", "hardware", "platform", "limitations"],
    "Manual record",
  );
  if (!Number.isFinite(Date.parse(record.observedAt)))
    throw new Error("Manual record requires a valid observedAt timestamp");
  if (!Array.isArray(record.checks) || !record.checks.length)
    throw new Error("Manual record requires observed checks");
  for (const check of record.checks) {
    requiredText(check, ["action", "expected", "observed"], "Manual check");
    if (!["passed", "failed"].includes(check.result))
      throw new Error("Manual check result must be passed or failed");
  }
  if (
    !Array.isArray(record.artifacts) ||
    !record.artifacts.length ||
    record.artifacts.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error("Manual record requires evidence artifact references");
  return record;
}

export function validateNativeObservation(observation, metadata) {
  requiredText(
    observation,
    ["model", "backend", "fixtureSha256"],
    "Native observation",
  );
  if (
    ![
      "r2t2",
      "r2t2Mlx",
      "netease-youdao/Confucius4-R2T2",
      "mlx-community/Confucius4-R2T2-bf16",
    ].includes(observation.model)
  )
    throw new Error("Observed speech model is not R2T2");
  if (observation.backend !== metadata.backend)
    throw new Error("Observed speech backend does not match supplied metadata");
  if (!Number.isInteger(observation.characters) || observation.characters <= 0)
    throw new Error(
      "Native observation requires a nonempty actual transcription",
    );
  if (!/^[a-f0-9]{64}$/.test(observation.fixtureSha256))
    throw new Error("Native observation requires a SHA-256 fixture hash");
  return observation;
}

export function makeReport(suite, plan, status, context) {
  return {
    schemaVersion: 1,
    suite,
    ...context,
    status,
    command: plan.command,
    scope: plan.scope,
    suppliedNativeMetadata: plan.metadata,
    evidence: Object.fromEntries(
      EVIDENCE_KINDS.map((kind) => [
        kind,
        plan.kinds.includes(kind) ? status : "not-run",
      ]),
    ),
  };
}

function saveReport(report) {
  mkdirSync(reportDirectory, { recursive: true });
  const path = join(reportDirectory, `${report.suite}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`\nEvidence: ${JSON.stringify(report.evidence)}`);
  console.log(`Scope: ${report.scope}\nReport: ${path}`);
}

async function unusedBrowserPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

export async function runSuite(suite, args) {
  const plan = planSuite(suite, args);
  const browserPort = suite === "browser" ? await unusedBrowserPort() : null;
  const startedAt = new Date().toISOString();
  const revisionBefore = revision();
  console.log(
    `Evidence suite ${suite}: ${plan.kinds.join(", ")}\n${plan.scope}`,
  );
  let error;
  const observationPath = plan.kinds.includes("native-inference")
    ? join(reportDirectory, `.native-${randomUUID()}.tmp`)
    : null;
  if (observationPath) mkdirSync(reportDirectory, { recursive: true });
  const result = await new Promise((resolveResult) => {
    const child = spawn(plan.command[0], plan.command.slice(1), {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        ...(suite === "browser"
          ? { CI: "1", DELULU_TEST_WEB_PORT: String(browserPort) }
          : {}),
        HF_HUB_OFFLINE: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
        DELULU_EVIDENCE_NATIVE_RESULT: observationPath ?? "",
      },
    });
    child.once("error", (cause) => {
      error = cause.message;
    });
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
  let nativeObservation = null;
  if (observationPath) {
    try {
      if (result.code === 0)
        nativeObservation = validateNativeObservation(
          JSON.parse(readFileSync(observationPath, "utf8")),
          plan.metadata,
        );
    } catch (cause) {
      error = `Native evidence: ${cause.message}`;
    } finally {
      rmSync(observationPath, { force: true });
    }
  }
  const revisionAfter = revision();
  const headChanged = revisionAfter.sha !== revisionBefore.sha;
  const status =
    result.code === 0 && !headChanged && !error ? "passed" : "failed";
  saveReport(
    makeReport(suite, plan, status, {
      revision: revisionBefore,
      revisionAfter,
      nativeObservation,
      browserPort,
      platform: platform(),
      architecture: arch(),
      osRelease: release(),
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.code,
      signal: result.signal,
      error: error ?? (headChanged ? "HEAD changed during verification" : null),
    }),
  );
  return status === "passed" ? 0 : result.code || 1;
}

export function summarizeReports(reports) {
  return Object.fromEntries(
    EVIDENCE_KINDS.map((kind) => [
      kind,
      reports
        .filter((report) => report.evidence[kind] !== "not-run")
        .map((report) => ({
          suite: report.suite,
          status: report.evidence[kind],
          revision: report.revision,
        })),
    ]),
  );
}

async function main() {
  const [suite, ...args] = process.argv.slice(2);
  if (suite === "summary") {
    const sha = revision().sha;
    let files = [];
    try {
      files = readdirSync(reportDirectory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const reports = files
      .filter((file) => file.endsWith(".json"))
      .map((file) =>
        JSON.parse(readFileSync(join(reportDirectory, file), "utf8")),
      )
      .filter((report) => report.revision.sha === sha);
    const summary = summarizeReports(reports);
    console.log(`Evidence for ${sha}:`);
    for (const kind of EVIDENCE_KINDS)
      console.log(
        `${kind}: ${summary[kind].length ? JSON.stringify(summary[kind]) : "not-run"}`,
      );
    return 0;
  }
  if (suite === "manual") {
    const recordPath = option(args, "--record");
    if (!recordPath || args.length)
      throw new Error("Use manual --record <file.json>");
    const current = revision();
    const record = validateManual(
      JSON.parse(readFileSync(recordPath, "utf8")),
      current.sha,
    );
    const failed = record.checks.some((check) => check.result === "failed");
    saveReport({
      ...makeReport(
        "manual",
        {
          command: null,
          kinds: ["manual-desktop"],
          scope:
            "Human-observed desktop evidence; recorded attestation, not an automated inference approval.",
          metadata: null,
        },
        failed ? "failed" : "recorded",
        { revision: current, finishedAt: new Date().toISOString() },
      ),
      manualObservation: record,
    });
    return failed ? 1 : 0;
  }
  return runSuite(suite, args);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`Evidence runner: ${error.message}`);
      process.exitCode = 1;
    });
}
