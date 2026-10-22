//! Pip's resolver report supplies hashes from its download metadata
//! (`artifacts.ts`). Those expectations stay in the install URLs so pip checks
//! the bytes before unpacking.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactVerification {
    ArchiveHash,
    HashUnavailable,
    VcsCommit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsInfo {
    #[serde(rename = "type")]
    pub kind: String,
    pub commit: String,
    pub requested_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeArtifact {
    pub name: String,
    pub version: String,
    pub url: String,
    /// Algorithm → lowercase hex digest, in report order.
    pub hashes: Map<String, Value>,
    pub verification: ArtifactVerification,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vcs: Option<VcsInfo>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedArtifacts {
    pub artifacts: Vec<RuntimeArtifact>,
    /// A `--requirement` file: one pinned URL per line, newline-terminated.
    pub requirements: String,
}

const DIGEST_LENGTHS: &[(&str, usize)] =
    &[("sha256", 64), ("sha512", 128), ("sha384", 96), ("sha224", 56), ("sha1", 40), ("md5", 32)];

fn has_line_break(text: &str) -> bool {
    text.contains(['\r', '\n', '\0'])
}

fn fragment_pairs(url: &Url) -> Vec<(String, String)> {
    url::form_urlencoded::parse(url.fragment().unwrap_or("").as_bytes()).into_owned().collect()
}

/// `url.hash = new URLSearchParams(pairs).toString()`.
fn set_fragment(url: &mut Url, pairs: &[(String, String)]) {
    let encoded = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish();
    url.set_fragment(if encoded.is_empty() { None } else { Some(&encoded) });
}

fn set_pair(pairs: &mut Vec<(String, String)>, key: &str, value: &str) {
    match pairs.iter().position(|(k, _)| k == key) {
        Some(index) => {
            pairs[index].1 = value.to_owned();
            let mut seen = false;
            pairs.retain(|(k, _)| {
                if k != key {
                    return true;
                }
                let keep = !seen;
                seen = true;
                keep
            });
        }
        None => pairs.push((key.to_owned(), value.to_owned())),
    }
}

fn artifact(item: &Value, requirements: &mut Vec<String>) -> Result<RuntimeArtifact, String> {
    static NAME: OnceLock<Regex> = OnceLock::new();
    static COMMIT: OnceLock<Regex> = OnceLock::new();
    let name_pattern = NAME.get_or_init(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$").unwrap());
    let (Some(metadata), Some(download)) = (
        item.get("metadata").and_then(Value::as_object),
        item.get("download_info").and_then(Value::as_object),
    ) else {
        return Err("missing artifact metadata".into());
    };
    let name = metadata.get("name").and_then(Value::as_str);
    let version = metadata.get("version").and_then(Value::as_str);
    let raw_url = download.get("url").and_then(Value::as_str);
    let (Some(name), Some(version), Some(raw_url)) = (name, version, raw_url) else {
        return Err("invalid artifact name, version or URL".into());
    };
    if !name_pattern.is_match(name)
        || version.trim().is_empty()
        || has_line_break(version)
        || raw_url.chars().any(|c| c.is_whitespace() || c == '\0')
    {
        return Err("invalid artifact name, version or URL".into());
    }
    let mut url = Url::parse(raw_url).map_err(|_| "Invalid URL".to_owned())?;
    if !["https", "http", "file"].contains(&url.scheme()) {
        return Err(format!("unsupported artifact URL: {}:", url.scheme()));
    }
    if let Some(subdirectory) = download.get("subdirectory") {
        let Some(subdirectory) = subdirectory.as_str().filter(|s| !has_line_break(s)) else {
            return Err("invalid artifact subdirectory".into());
        };
        let mut pairs = fragment_pairs(&url);
        set_pair(&mut pairs, "subdirectory", subdirectory);
        set_fragment(&mut url, &pairs);
    }
    let mut artifact = RuntimeArtifact {
        name: name.to_owned(),
        version: version.to_owned(),
        url: raw_url.to_owned(),
        hashes: Map::new(),
        verification: ArtifactVerification::HashUnavailable,
        vcs: None,
    };
    if let Some(vcs) = download.get("vcs_info").and_then(Value::as_object) {
        let commit_pattern = COMMIT.get_or_init(|| Regex::new(r"(?i)^(?:[a-f0-9]{40}|[a-f0-9]{64})$").unwrap());
        let commit = vcs.get("commit_id").and_then(Value::as_str);
        let Some(commit) = commit.filter(|c| vcs.get("vcs").and_then(Value::as_str) == Some("git") && commit_pattern.is_match(c))
        else {
            return Err("Git artifact has no immutable commit".into());
        };
        artifact.verification = ArtifactVerification::VcsCommit;
        artifact.vcs = Some(VcsInfo {
            kind: "git".into(),
            commit: commit.to_owned(),
            requested_revision: vcs.get("requested_revision").and_then(Value::as_str).map(str::to_owned),
        });
        let fragment = url.fragment().map(|f| format!("#{f}")).unwrap_or_default();
        url.set_fragment(None);
        requirements.push(format!("{name} @ git+{url}@{commit}{fragment}"));
    } else if let Some(archive) = download.get("archive_info").and_then(Value::as_object) {
        let mut hashes: Vec<(String, Value)> = match archive.get("hashes") {
            None => Vec::new(),
            Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            Some(_) => return Err(format!("invalid archive hashes for {name}")),
        };
        // Older pip reports used a single algorithm=digest entry.
        if let Some(single) = archive.get("hash").and_then(Value::as_str) {
            let mut split = single.split('=');
            let algorithm = split.next().unwrap_or_default().to_owned();
            let digest = split.next().map(|d| Value::String(d.to_owned())).unwrap_or(Value::Null);
            if !hashes.iter().any(|(k, _)| *k == algorithm) {
                hashes.push((algorithm, digest));
            }
        }
        for (algorithm, digest) in hashes {
            let expected = DIGEST_LENGTHS.iter().find(|(key, _)| *key == algorithm).map(|(_, length)| *length);
            let valid = digest.as_str().filter(|d| {
                !d.is_empty() && d.bytes().all(|b| b.is_ascii_hexdigit()) && expected.is_none_or(|length| d.len() == length)
            });
            let Some(digest) = valid else {
                return Err(format!("invalid {algorithm} digest for {name}"));
            };
            artifact.hashes.insert(algorithm, Value::String(digest.to_ascii_lowercase()));
        }
        let strongest = DIGEST_LENGTHS.iter().map(|(key, _)| *key).find(|key| artifact.hashes.contains_key(*key));
        if let Some(algorithm) = strongest {
            artifact.verification = ArtifactVerification::ArchiveHash;
            let mut pairs = fragment_pairs(&url);
            pairs.retain(|(key, _)| !DIGEST_LENGTHS.iter().any(|(name, _)| name == key));
            let digest = artifact.hashes[algorithm].as_str().unwrap_or_default().to_owned();
            set_pair(&mut pairs, algorithm, &digest);
            set_fragment(&mut url, &pairs);
        }
        requirements.push(format!("{name} @ {url}"));
    } else {
        return Err(format!("unsupported artifact source for {name}"));
    }
    Ok(artifact)
}

/// Parses `pip install --dry-run --report` output into hash-pinned requirements.
pub fn resolve_runtime_artifacts(output: &str) -> Result<ResolvedArtifacts, String> {
    let inner = || -> Result<ResolvedArtifacts, String> {
        let report: Value = serde_json::from_str(output).map_err(|error| error.to_string())?;
        let install = match (report.get("version").and_then(Value::as_str), report.get("install")) {
            (Some("1"), Some(Value::Array(install))) => install,
            _ => return Err("invalid pip resolver report".into()),
        };
        let mut requirements = Vec::new();
        let artifacts = install.iter().map(|item| artifact(item, &mut requirements)).collect::<Result<Vec<_>, _>>()?;
        Ok(ResolvedArtifacts { artifacts, requirements: format!("{}\n", requirements.join("\n")) })
    };
    inner().map_err(|error| {
        format!("Could not record runtime artifact hashes: {error}. The previous environment is unchanged.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hashes_are_pinned_into_requirement_urls() {
        let digest = "A".repeat(64);
        let report = json!({ "version": "1", "install": [
            { "metadata": { "name": "torch", "version": "2.13.0" },
              "download_info": { "url": "https://files.example/torch.whl#md5=00", "archive_info": { "hashes": { "sha256": digest } } } },
            { "metadata": { "name": "pkg", "version": "1" },
              "download_info": { "url": "https://github.com/a/b", "subdirectory": "sub dir",
                                 "vcs_info": { "vcs": "git", "commit_id": "a".repeat(40) } } },
        ]});
        let resolved = resolve_runtime_artifacts(&report.to_string()).unwrap();
        let lines: Vec<_> = resolved.requirements.lines().collect();
        assert_eq!(lines[0], format!("torch @ https://files.example/torch.whl#sha256={}", "a".repeat(64)));
        assert_eq!(lines[1], format!("pkg @ git+https://github.com/a/b@{}#subdirectory=sub+dir", "a".repeat(40)));
        assert_eq!(resolved.artifacts[0].verification, ArtifactVerification::ArchiveHash);
        let bad = json!({ "version": "1", "install": [{ "metadata": { "name": "x", "version": "1" },
            "download_info": { "url": "ftp://x/y", "archive_info": {} } }] });
        let error = resolve_runtime_artifacts(&bad.to_string()).unwrap_err();
        assert!(error.contains("unsupported artifact URL: ftp:") && error.ends_with("The previous environment is unchanged."));
        let empty = resolve_runtime_artifacts(r#"{"version":"1","install":[]}"#).unwrap();
        assert!(empty.artifacts.is_empty() && empty.requirements == "\n");
    }
}
