"""Verified checkpoint downloads with fake Hub and HTTP objects, no network."""
import hashlib
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import verified_snapshot

REPO = "owner/model"
REVISION = "a" * 40
GOOD = b"weights" * 100
BAD = b"WEIGHTS" * 100


class FakeFileLock:
    def __init__(self, path, timeout=None):
        self.path = path

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeResponse:
    status = 200
    headers = {}

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, size=-1):
        body, self.body = self.body, b""
        return body


def git_blob_digest(content):
    return hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()


class VerifiedSnapshotTests(unittest.TestCase):
    def test_repeated_bad_digests_keep_at_most_one_corrupt_copy(self):
        expected = git_blob_digest(GOOD)
        metadata = SimpleNamespace(etag=expected, commit_hash=REVISION, size=len(GOOD), location="https://example.test/blob")
        hub = types.ModuleType("huggingface_hub")
        hub.HfApi = lambda: SimpleNamespace(model_info=lambda repo, revision, files_metadata: SimpleNamespace(
            sha=REVISION, siblings=[SimpleNamespace(rfilename="model.safetensors")]))
        hub.get_hf_file_metadata = lambda url: metadata
        hub.hf_hub_url = lambda repo, name, revision: f"https://example.test/{name}"
        def not_cached(*args, **kwargs):
            raise OSError("not cached")

        hub.hf_hub_download = not_cached
        constants = types.ModuleType("huggingface_hub.constants")
        constants.HF_HUB_CACHE = tempfile.gettempdir()
        filelock = types.ModuleType("filelock")
        filelock.FileLock = FakeFileLock
        modules = {"huggingface_hub": hub, "huggingface_hub.constants": constants, "filelock": filelock}

        with tempfile.TemporaryDirectory() as cache, patch.dict(sys.modules, modules), \
                patch.dict(os.environ), patch.object(verified_snapshot, "urlopen", lambda *a, **k: FakeResponse(BAD)), \
                patch("worker_protocol.emit_progress"):
            os.environ.pop("HF_HUB_OFFLINE", None)
            target = Path(cache) / "delulu-verified" / "owner--model" / REVISION / "model.safetensors"
            for _ in range(3):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(BAD)
                with self.assertRaisesRegex(RuntimeError, "hash mismatch"):
                    verified_snapshot.verified_snapshot(
                        repo_id=REPO, revision=REVISION, cache_dir=cache, allow_patterns=["model.safetensors"])
            corrupt = sorted(path.name for path in target.parent.iterdir() if ".corrupt" in path.name)
        self.assertEqual(corrupt, ["model.safetensors.corrupt"])


if __name__ == "__main__":
    unittest.main()
