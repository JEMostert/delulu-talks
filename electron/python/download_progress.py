"""Observe explicit Hub byte bars without replacing global download hooks."""

import contextlib
import math
import threading
import time

from worker_protocol import capture_progress_emitter


def download_progress_class():
    """Build a request-bound tqdm subclass; Hub imports stay lazy."""
    from huggingface_hub.utils.tqdm import tqdm

    emit = capture_progress_emitter()
    lock = threading.RLock()
    last_emitted = None

    def safe_count(value):
        if type(value) not in (int, float):
            return None
        try:
            if math.isfinite(value) and 0 <= value <= 2**53 - 1 and value == int(value):
                return int(value)
        except (OverflowError, ValueError):
            pass
        return None

    class DownloadProgress(tqdm):
        def __init__(self, *args, **kwargs):
            self._download_ready = False
            self._download_name = str(kwargs.get("name", ""))
            self._download_unit = kwargs.get("unit", "it")
            self._download_desc = str(kwargs.get("desc", ""))
            super().__init__(*args, **kwargs)
            self._download_ready = True
            self._report_bytes()

        def _report_bytes(self):
            nonlocal last_emitted
            if not self._download_ready or getattr(self, "unit", self._download_unit) != "B":
                return
            with lock:
                completed = safe_count(getattr(self, "n", None))
                if completed is None:
                    return
                total = safe_count(getattr(self, "total", None))
                # Snapshot totals can grow as more files are discovered.
                if total == 0 or (total is not None and completed > total):
                    total = None
                label = (self._download_name + " " + str(getattr(self, "desc", self._download_desc))).lower()
                kind = "transfer" if "transfer" in label or "downloading bytes" in label else "reconstruction"
                now = time.monotonic()
                if last_emitted is not None and now - last_emitted < 0.25:
                    return
                # Reporting failures cannot change the checkpoint download.
                with contextlib.suppress(Exception):
                    emit(
                        "Downloading checkpoint bytes" if kind == "transfer" else "Reconstructing checkpoint bytes",
                        stage="download",
                        download_bytes={"completed": completed, "total": total, "kind": kind},
                    )
                last_emitted = now

        def update(self, n=1):
            with lock:
                if getattr(self, "disable", False) and n is not None:
                    # tqdm skips its own counter when rendering is disabled.
                    self.n += n
                result = super().update(n)
                self._report_bytes()
                return result

        def refresh(self, *args, **kwargs):
            with lock:
                result = super().refresh(*args, **kwargs)
                self._report_bytes()
                return result

        def close(self):
            with lock:
                result = super().close()
                self._report_bytes()
                return result

    # Superclass rendering and observations share this subclass's own lock.
    DownloadProgress.set_lock(lock)
    return DownloadProgress
