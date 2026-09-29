"""Explicit resumable downloads for pinned public speech checkpoints.

Never load partial files. Partial prefixes are trusted only after the completed
file matches the repository's immutable Git/LFS digest. No credentials persist.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

PATTERNS = ["*.json", "*.safetensors", "*.model", "*.txt", "*.tiktoken"]


def _digest(path, expected):
    git = len(expected) == 40
    digest = hashlib.sha1() if git else hashlib.sha256()
    if git:
        digest.update(f"blob {path.stat().st_size}\0".encode())
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _entry_path(root, name):
    path = Path(name)
    if path.is_absolute() or not path.parts or any(part in ("..", ".") for part in path.parts):
        raise ValueError("Invalid checkpoint filename")
    target = root / path
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("Checkpoint path escapes snapshot directory")
    return target


def verified_snapshot(repo_id, revision, cache_dir=None, local_files_only=False, allow_patterns=None):
    from filelock import FileLock
    from huggingface_hub import HfApi, get_hf_file_metadata, hf_hub_url, hf_hub_download
    from huggingface_hub.constants import HF_HUB_CACHE
    from worker_protocol import emit_progress

    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Resumable speech downloads require an immutable revision")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo_id):
        raise ValueError("Invalid public checkpoint repository")
    root = Path(cache_dir or HF_HUB_CACHE) / "delulu-verified" / repo_id.replace("/", "--") / revision
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "verified-files.json"
    # One writer owns both range requests and publication. Other processes wait.
    with FileLock(str(root) + ".lock", timeout=1800):
        if local_files_only or os.environ.get("HF_HUB_OFFLINE") == "1":
            if not manifest.is_file():
                raise RuntimeError("This pinned checkpoint has no verified offline snapshot. Complete one online load first.")
            document = json.loads(manifest.read_text())
            if document.get("repo") != repo_id or document.get("revision") != revision or document.get("version") != 1:
                raise RuntimeError("Offline snapshot verification metadata is invalid")
            entries = document.get("files")
            if not isinstance(entries, list) or not entries:
                raise RuntimeError("Offline snapshot file list is missing")
        else:
            info = HfApi().model_info(repo_id, revision=revision, files_metadata=True)
            if info.sha != revision:
                raise RuntimeError("Checkpoint metadata did not resolve to the pinned revision")
            entries = []
            for sibling in info.siblings:
                name = sibling.rfilename
                if not any(fnmatch.fnmatch(name, pattern) for pattern in (allow_patterns or PATTERNS)):
                    continue
                metadata = get_hf_file_metadata(hf_hub_url(repo_id, name, revision=revision))
                expected = str(metadata.etag or "").strip('"')
                if metadata.commit_hash != revision or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", expected):
                    raise RuntimeError(f"No immutable file digest for {name}")
                if not isinstance(metadata.size, int) or not 0 <= metadata.size <= 64 * 1024**3:
                    raise RuntimeError(f"Invalid checkpoint size for {name}")
                entries.append({"name": name, "size": metadata.size, "digest": expected})
            if not entries or not any(entry["name"].endswith(".safetensors") for entry in entries):
                raise RuntimeError("Pinned snapshot does not contain speech weights")
        for entry in entries:
            name, size, expected = entry["name"], entry["size"], entry["digest"]
            if not isinstance(size, int) or size < 0 or not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", expected):
                raise RuntimeError("Invalid verified snapshot entry")
            target = _entry_path(root, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            emit_progress(f"Checking pinned checkpoint file {name}", stage="download")
            if target.is_file() and target.stat().st_size == size and _digest(target, expected) == expected:
                continue
            if local_files_only or os.environ.get("HF_HUB_OFFLINE") == "1":
                raise RuntimeError(f"Offline checkpoint file is missing or corrupt: {name}. Reconnect and retry setup.")
            # Never overwrite a bad final artifact: preserve it for diagnosis.
            if target.exists():
                target.rename(target.with_name(target.name + ".corrupt-" + uuid.uuid4().hex))
            # Reuse existing standard Hub blobs only after checking the upstream
            # pinned digest. Hard-link complete immutable content where supported.
            try:
                cached = Path(hf_hub_download(repo_id, name, revision=revision,
                                              cache_dir=cache_dir, local_files_only=True))
            except Exception:
                cached = None
            if cached is not None and cached.is_file() and cached.stat().st_size == size and _digest(cached, expected) == expected:
                try:
                    os.link(cached, target)
                except OSError:
                    shutil.copyfile(cached, target)
                continue
            partial = target.with_name(target.name + ".partial")
            receipt = partial.with_name(partial.name + ".json")
            identity = {"revision": revision, "name": name, "size": size, "digest": expected}
            try:
                matching = json.loads(receipt.read_text()) == identity
            except (OSError, ValueError):
                matching = False
            if partial.exists() and (not matching or partial.stat().st_size > size):
                partial.rename(partial.with_name(partial.name + ".obsolete-" + uuid.uuid4().hex))
            receipt.write_text(json.dumps(identity))
            offset = partial.stat().st_size if partial.exists() else 0
            if offset < size:
                metadata = get_hf_file_metadata(hf_hub_url(repo_id, name, revision=revision))
                if str(metadata.etag or "").strip('"') != expected or metadata.size != size:
                    raise RuntimeError("Checkpoint changed during download")
                request = Request(metadata.location, headers={"Range": f"bytes={offset}-"} if offset else {})
                emit_progress(f"Downloading {name} from byte {offset} of {size}", stage="download")
                with urlopen(request, timeout=60) as response:
                    if response.status == 206:
                        content_range = response.headers.get("Content-Range", "")
                        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
                        if not match or int(match[1]) != offset or int(match[3]) != size or int(match[2]) != size - 1:
                            raise RuntimeError("Download server returned an invalid resume range")
                        mode = "ab" if offset else "wb"
                    elif response.status == 200:
                        # Range ignored: restart this file, never append full content.
                        offset, mode = 0, "wb"
                    else:
                        raise RuntimeError("Unexpected checkpoint download response")
                    with partial.open(mode) as output:
                        while chunk := response.read(8 * 1024 * 1024):
                            offset += len(chunk)
                            if offset > size:
                                raise RuntimeError("Checkpoint download exceeded expected size")
                            output.write(chunk)
                        output.flush()
                        os.fsync(output.fileno())
            if partial.stat().st_size != size:
                raise RuntimeError(f"Interrupted download retained for retry: {name}")
            if _digest(partial, expected) != expected:
                partial.rename(partial.with_name(partial.name + ".corrupt-" + uuid.uuid4().hex))
                raise RuntimeError(f"Checkpoint hash mismatch: {name}. Corrupt partial preserved; retry downloads a fresh file.")
            os.replace(partial, target)
            receipt.unlink(missing_ok=True)
        temporary = manifest.with_name(manifest.name + "." + uuid.uuid4().hex + ".tmp")
        temporary.write_text(json.dumps({"version": 1, "repo": repo_id, "revision": revision, "files": entries}))
        os.replace(temporary, manifest)
    return str(root)
