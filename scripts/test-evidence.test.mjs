import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  EVIDENCE_KINDS,
  makeReport,
  planSuite,
  summarizeReports,
  validateManual,
  validateNativeObservation,
} from "./test-evidence.mjs";

const sha = "a".repeat(40);
const manual = () => ({
  kind: "manual-desktop",
  sha,
  observer: "fixture-observer",
  observedAt: "2026-09-29T12:00:00Z",
  hardware: "fixture desktop",
  platform: "linux",
  limitations:
    "Fixture record validates reporting only; no manual observation occurred.",
  checks: [
    {
      action: "Paste fixture",
      expected: "one copy",
      observed: "one copy",
      result: "passed",
    },
  ],
  artifacts: ["local observation log"],
});

describe("evidence boundaries", () => {
  test("native success requires observed R2T2 transcription and the selected backend", () => {
    const observation = {
      model: "netease-youdao/Confucius4-R2T2",
      backend: "cuda-vllm",
      fixtureSha256: "a".repeat(64),
      characters: 20,
    };
    expect(
      validateNativeObservation(observation, { backend: "cuda-vllm" }),
    ).toBe(observation);
    expect(() =>
      validateNativeObservation(
        { ...observation, model: "Qwen3-ASR" },
        { backend: "cuda-vllm" },
      ),
    ).toThrow("not R2T2");
    expect(() =>
      validateNativeObservation(observation, { backend: "mlx" }),
    ).toThrow("does not match");
    expect(() =>
      validateNativeObservation(
        { ...observation, characters: 0 },
        { backend: "cuda-vllm" },
      ),
    ).toThrow("nonempty actual");
  });

  test("listing/help/filter options cannot become completed evidence", () => {
    for (const [suite, args] of [
      ["unit", ["--help"]],
      ["unit", ["--pass-with-no-tests"]],
      ["unit", ["some.test.ts"]],
      ["browser", ["--list"]],
      ["python", ["--help"]],
      ["python", ["-p", "missing.py"]],
    ])
      expect(() => planSuite(suite, args)).toThrow("complete suite");
  });

  test("real Electron without a runtime proves fixtures, not native inference or manual delivery", () => {
    const report = makeReport("desktop", planSuite("desktop"), "passed", {});
    expect(report.evidence).toEqual({
      "fixture-only": "passed",
      mocked: "not-run",
      "native-inference": "not-run",
      "manual-desktop": "not-run",
    });
    expect(report.scope).toContain("Real isolated Electron");
  });

  test("mocked suites never establish native evidence", () => {
    for (const suite of ["unit", "python", "browser"]) {
      const report = makeReport(suite, planSuite(suite), "passed", {});
      expect(report.evidence.mocked).toBe("passed");
      expect(report.evidence["native-inference"]).toBe("not-run");
      expect(report.evidence["manual-desktop"]).toBe("not-run");
    }
  });

  test("native runs require provenance and an explicit existing-runtime interpreter/cache", () => {
    expect(() => planSuite("native")).toThrow("--python");
    expect(() => planSuite("native", ["--python", "runtime-python"])).toThrow(
      "--cache",
    );
    expect(() =>
      planSuite("native", ["--python", "runtime-python", "--cache", "cache"]),
    ).toThrow("--metadata");
    expect(() => planSuite("desktop", ["runtime-directory"])).toThrow(
      "--metadata",
    );
    expect(() => planSuite("desktop", ["--writing"])).toThrow(
      "runtime directory",
    );
  });

  test("package reporting refuses runtime warmup rather than calling it fixture-only", () => {
    expect(() => planSuite("mac-package", ["app", "runtime"])).toThrow(
      "without a runtime",
    );
    const plan = planSuite("mac-package", ["app"]);
    expect(plan.kinds).toEqual(["fixture-only"]);
    expect(plan.scope).toContain("No inference");
  });

  test("failed native attempt cannot become passed evidence in a summary", () => {
    const report = makeReport(
      "native",
      {
        command: ["python"],
        kinds: ["native-inference"],
        scope: "fixture",
        metadata: null,
      },
      "failed",
      { revision: { sha, dirty: false } },
    );
    const summary = summarizeReports([report]);
    expect(summary["native-inference"][0].status).toBe("failed");
    expect(summary["manual-desktop"]).toEqual([]);
    expect(Object.keys(summary)).toEqual(EVIDENCE_KINDS);
  });

  test("manual observation requires the tested commit and concrete observed checks", () => {
    expect(validateManual(manual(), sha).observer).toBe("fixture-observer");
    expect(() =>
      validateManual({ ...manual(), sha: "b".repeat(40) }, sha),
    ).toThrow("current full head SHA");
    expect(() => validateManual({ ...manual(), checks: [] }, sha)).toThrow(
      "observed checks",
    );
    expect(() => validateManual({ ...manual(), artifacts: [] }, sha)).toThrow(
      "artifact references",
    );
    expect(() => validateManual({ ...manual(), observer: "" }, sha)).toThrow(
      "observer",
    );
    expect(() =>
      validateManual({ ...manual(), observedAt: "invalid" }, sha),
    ).toThrow("timestamp");
  });
});

test.skipIf(process.platform === "win32")(
  "runner preserves child failure and emits failed evidence; summary does not promote it",
  () => {
    const root = mkdtempSync(join(tmpdir(), "delulu-evidence-"));
    const runner = resolve("scripts/test-evidence.mjs");
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
          "-q",
        ],
        { cwd: root },
      );
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "bun"),
        "#!/usr/bin/env node\nprocess.exit(7);\n",
        { mode: 0o700 },
      );
      const result = spawnSync(
        process.execPath.includes("bun") ? "node" : process.execPath,
        [runner, "unit"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(7);
      const reports = readdirSync(join(root, "artifacts/verification"));
      expect(reports).toHaveLength(1);
      const report = JSON.parse(
        readFileSync(join(root, "artifacts/verification", reports[0]), "utf8"),
      );
      expect(report.exitCode).toBe(7);
      expect(report.status).toBe("failed");
      expect(report.evidence.mocked).toBe("failed");
      expect(report.evidence["native-inference"]).toBe("not-run");
      const summary = spawnSync("node", [runner, "summary"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(summary.status).toBe(0);
      expect(summary.stdout).toContain('"status":"failed"');
      expect(summary.stdout).toContain("native-inference: not-run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
