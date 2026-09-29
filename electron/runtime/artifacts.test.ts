import { expect, test } from "bun:test";
import { resolveRuntimeArtifacts } from "./artifacts";

function report(download: Record<string, unknown>): string {
  return JSON.stringify({ version: "1", install: [{
    metadata: { name: "package", version: "1.0" }, download_info: download,
  }] });
}

test("resolved archive installs retain upstream hashes and replace stale URL digests", () => {
  const digest = "a".repeat(64);
  const resolved = resolveRuntimeArtifacts(report({
    url: "https://packages.example/package.whl#sha256=old",
    archive_info: { hashes: { sha256: digest } },
  }));
  expect(resolved.requirements).toBe(`package @ https://packages.example/package.whl#sha256=${digest}\n`);
  expect(resolved.artifacts[0].hashes).toEqual({ sha256: digest });
  expect(resolved.artifacts[0].verification).toBe("archive-hash");
});

test("Git reports install immutable commits and preserve subdirectories", () => {
  const commit = "b".repeat(40);
  const resolved = resolveRuntimeArtifacts(report({
    url: "https://github.com/example/runtime.git", subdirectory: "python",
    vcs_info: { vcs: "git", commit_id: commit, requested_revision: "main" },
  }));
  expect(resolved.requirements).toBe(`package @ git+https://github.com/example/runtime.git@${commit}#subdirectory=python\n`);
  expect(resolved.artifacts[0].verification).toBe("vcs-commit");
  expect(resolved.artifacts[0].hashes).toEqual({});
});

test("archives without publisher hashes explicitly record the limitation", () => {
  const resolved = resolveRuntimeArtifacts(report({
    url: "https://packages.example/package.whl", archive_info: {},
  }));
  expect(resolved.artifacts[0].verification).toBe("hash-unavailable");
});

test("invalid reports fail before creating installation requirements", () => {
  for (const input of ["{", JSON.stringify({ version: "2", install: [] }), report({
    url: "https://packages.example/package.whl",
    archive_info: { hashes: { sha256: "wrong" } },
  }), report({
    url: "https://github.com/example/runtime.git",
    vcs_info: { vcs: "git", commit_id: "main" },
  })]) expect(() => resolveRuntimeArtifacts(input)).toThrow("The previous environment is unchanged");
});
