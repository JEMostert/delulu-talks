/** Pip's resolver report supplies hashes from its download metadata. Keep those
 * expectations in the install URLs so pip checks the bytes before unpacking.
 */
export type RuntimeArtifact = {
  name: string;
  version: string;
  url: string;
  hashes: Record<string, string>;
  verification: "archive-hash" | "hash-unavailable" | "vcs-commit";
  vcs?: { type: "git"; commit: string; requestedRevision: string | null };
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveRuntimeArtifacts(output: string): {
  artifacts: RuntimeArtifact[];
  requirements: string;
} {
  try {
    const report: unknown = JSON.parse(output);
    if (
      !object(report) ||
      report.version !== "1" ||
      !Array.isArray(report.install)
    )
      throw new Error("invalid pip resolver report");
    const requirements: string[] = [];
    const artifacts: RuntimeArtifact[] = report.install.map((item: unknown) => {
      if (
        !object(item) ||
        !object(item.metadata) ||
        !object(item.download_info)
      )
        throw new Error("missing artifact metadata");
      const { name, version } = item.metadata;
      const download = item.download_info;
      if (
        typeof name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
        typeof version !== "string" ||
        !version.trim() ||
        /[\r\n\0]/.test(version) ||
        typeof download.url !== "string" ||
        /[\s\0]/.test(download.url)
      )
        throw new Error("invalid artifact name, version or URL");
      const url = new URL(download.url);
      if (!["https:", "http:", "file:"].includes(url.protocol))
        throw new Error(`unsupported artifact URL: ${url.protocol}`);
      if (download.subdirectory !== undefined) {
        if (
          typeof download.subdirectory !== "string" ||
          /[\r\n\0]/.test(download.subdirectory)
        )
          throw new Error("invalid artifact subdirectory");
        const fragment = new URLSearchParams(url.hash.slice(1));
        fragment.set("subdirectory", download.subdirectory);
        url.hash = fragment.toString();
      }
      const artifact: RuntimeArtifact = {
        name,
        version,
        url: download.url,
        hashes: {},
        verification: "hash-unavailable",
      };
      if (object(download.vcs_info)) {
        const vcs = download.vcs_info;
        if (
          vcs.vcs !== "git" ||
          typeof vcs.commit_id !== "string" ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(vcs.commit_id)
        )
          throw new Error("Git artifact has no immutable commit");
        artifact.verification = "vcs-commit";
        artifact.vcs = {
          type: "git",
          commit: vcs.commit_id,
          requestedRevision:
            typeof vcs.requested_revision === "string"
              ? vcs.requested_revision
              : null,
        };
        const fragment = url.hash;
        url.hash = "";
        requirements.push(
          `${name} @ git+${url.href}@${vcs.commit_id}${fragment}`,
        );
      } else if (object(download.archive_info)) {
        const archive = download.archive_info;
        if (archive.hashes !== undefined && !object(archive.hashes))
          throw new Error(`invalid archive hashes for ${name}`);
        const hashes = object(archive.hashes) ? { ...archive.hashes } : {};
        // Older pip reports used a single algorithm=digest entry.
        if (typeof archive.hash === "string") {
          const [algorithm, digest] = archive.hash.split("=");
          if (!(algorithm in hashes)) hashes[algorithm] = digest;
        }
        const lengths: Record<string, number> = {
          sha256: 64,
          sha512: 128,
          sha384: 96,
          sha224: 56,
          sha1: 40,
          md5: 32,
        };
        for (const [algorithm, digest] of Object.entries(hashes)) {
          if (
            typeof digest !== "string" ||
            !/^[a-f0-9]+$/i.test(digest) ||
            (algorithm in lengths && digest.length !== lengths[algorithm])
          )
            throw new Error(`invalid ${algorithm} digest for ${name}`);
          artifact.hashes[algorithm] = digest.toLowerCase();
        }
        const algorithm = Object.keys(lengths).find(
          (key) => artifact.hashes[key],
        );
        if (algorithm) {
          artifact.verification = "archive-hash";
          const fragment = new URLSearchParams(url.hash.slice(1));
          for (const key of Object.keys(lengths)) fragment.delete(key);
          fragment.set(algorithm, artifact.hashes[algorithm]);
          url.hash = fragment.toString();
        }
        requirements.push(`${name} @ ${url.href}`);
      } else {
        throw new Error(`unsupported artifact source for ${name}`);
      }
      return artifact;
    });
    return { artifacts, requirements: `${requirements.join("\n")}\n` };
  } catch (error) {
    throw new Error(
      `Could not record runtime artifact hashes: ${error instanceof Error ? error.message : String(error)}. The previous environment is unchanged.`,
    );
  }
}
