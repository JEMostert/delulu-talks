import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type SetupStage =
  | "interpreter"
  | "venv"
  | "installer"
  | "cuda"
  | "runtime"
  | "check"
  | "readiness"
  | "freeze"
  | "inventory";
export type SetupControl = {
  failStage?: SetupStage;
  pauseStage?: SetupStage;
  blockActivationWrite?: boolean;
  blockReportWrite?: "freeze" | "inventory";
};
export type SetupLogEntry = {
  stage: SetupStage;
  event: "start" | "failed" | "paused" | "terminated" | "finished";
  pid: number;
  candidate: string | null;
  args: string[];
};

/** Real POSIX child executable; all Python/pip/package behavior is synthetic. */
export function createSetupFixture(root: string) {
  mkdirSync(root, { recursive: true });
  const program = join(root, "fixture-python");
  const controlPath = join(root, "fixture-control.json");
  const logPath = join(root, "fixture-commands.jsonl");
  const script = `#!${process.execPath}
import {
  appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const program = process.argv[1];
const args = process.argv.slice(2);
const code = args.includes("-c") ? args[args.indexOf("-c") + 1] : "";
let candidate = dirname(dirname(program));
let stage;
if (code.includes("print('.'.join")) {
  stage = "interpreter";
  candidate = null;
} else if (args[0] === "-m" && args[1] === "venv") {
  stage = "venv";
  candidate = args.at(-1);
} else if (args[0] === "-m" && args[1] === "pip") {
  if (args[2] === "check") stage = "check";
  else if (args[2] === "freeze") stage = "freeze";
  else if (args[2] === "install") {
    stage = args.includes("--index-url") ? "cuda"
      : args.some(arg => arg.startsWith("pip==")) ? "installer" : "runtime";
  }
} else if (code.includes("metadata.distributions()")) {
  stage = "inventory";
} else if (code) stage = "readiness";
if (!stage) throw new Error("Unexpected synthetic command: " + JSON.stringify(args));
const log = event => appendFileSync(process.env.DELULU_SETUP_FIXTURE_LOG,
  JSON.stringify({ stage, event, pid: process.pid, candidate, args }) + "\\n");
log("start");
const control = JSON.parse(readFileSync(process.env.DELULU_SETUP_FIXTURE_CONTROL, "utf8"));
// Copied old interpreters have no marker: readiness of the prior runtime is
// never failed or paused by controls intended for a new setup candidate.
const controlled = stage === "interpreter" || stage === "venv" ||
  existsSync(join(candidate, "setup-fixture-candidate.json"));
if (stage === "venv") {
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(candidate, "setup-fixture-candidate.json"), '{"synthetic":true}');
}
if (controlled && (control.pauseStage === stage || control.failStage === stage)) {
  if (candidate) writeFileSync(join(candidate, "download.partial"), "partial synthetic download");
  if (control.failStage === stage) {
    log("failed");
    console.error("Synthetic setup failure at " + stage);
    process.exit(17);
  }
  log("paused");
  process.on("SIGTERM", () => { log("terminated"); process.exit(143); });
  console.log("fixture-download-paused:" + stage + ":" + process.pid);
  setInterval(() => {
    if (candidate) appendFileSync(join(candidate, "download.partial"), ".");
  }, 25);
} else {
  if (controlled && control.blockReportWrite === stage) {
    // A real EISDIR write/rename failure in the installer, after child success.
    for (const kind of ["speech", "magic"]) {
      const suffix = stage === "freeze" ? "installed.txt" : "inventory.json";
      mkdirSync(join(candidate, "runtime-" + kind + "-" + suffix));
    }
  }
  if (stage === "interpreter") console.log("3.12");
  if (stage === "venv") {
    for (const relative of ["bin/python", "Scripts/python.exe"]) {
      const executable = join(candidate, relative);
      mkdirSync(dirname(executable), { recursive: true });
      copyFileSync(program, executable);
    }
  }
  if (stage === "runtime") writeFileSync(join(candidate, "download.complete"), "complete synthetic download");
  if (stage === "freeze") console.log("setup-fixture-package==1.0.0");
  if (stage === "inventory") {
    if (controlled && control.blockActivationWrite)
      chmodSync(dirname(dirname(candidate)), 0o500);
    // Explicit simulated interpreter/package data, never native Python evidence.
    console.log(JSON.stringify({
      interpreter: {
        executable: program, version: "3.12.0", fullVersion: "Synthetic setup fixture, no Python packages installed",
        implementation: "SyntheticFixture", prefix: candidate,
        basePrefix: dirname(process.env.DELULU_SETUP_FIXTURE_CONTROL),
        platform: process.platform, system: "Synthetic fixture host", release: "fixture",
        machine: process.arch, pointerBits: 64,
      },
      distributions: [{ name: "setup-fixture-package", version: "1.0.0" }],
      distributionCount: 1,
    }));
  }
  log("finished");
}
`;
  writeFileSync(program, script, { mode: 0o700 });
  const writeControl = (control: SetupControl) => {
    const temporary = `${controlPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(control), { mode: 0o600 });
    renameSync(temporary, controlPath);
  };
  writeControl({});
  return {
    program,
    controlPath,
    logPath,
    environment: {
      ...process.env,
      DELULU_SETUP_FIXTURE_CONTROL: controlPath,
      DELULU_SETUP_FIXTURE_LOG: logPath,
    },
    writeControl,
    readLog: (): SetupLogEntry[] =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}
