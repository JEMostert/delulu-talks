"""Opt-in harness instrumentation; production worker source remains unchanged."""
import atexit
import ipaddress
import json
import os
from pathlib import Path
import runpy
import socket
import sys
import time
import threading

source = Path(os.environ["DELULU_NATIVE_WORKER_SOURCE"]).resolve()
journal = Path(os.environ["DELULU_NATIVE_OBSERVATION_JOURNAL"]).resolve()
sys.path.insert(0, str(source.parent))
try:
    observations = json.loads(journal.read_text(encoding="utf8"))
except FileNotFoundError:
    observations = {"schemaVersion": 1, "events": [], "networkAttempts": [], "externalNetworkAttempts": 0}

lock = threading.RLock()

def persist():
    with lock:
        temporary = journal.with_suffix(".tmp")
        temporary.write_text(json.dumps(observations), encoding="utf8")
        temporary.chmod(0o600)
        temporary.replace(journal)

def record(event, **fields):
    with lock:
        observations["events"].append({"event": event, "pid": os.getpid(), "time": time.time(), **fields})
        observations["events"] = observations["events"][-500:]
        persist()

def local(host):
    if host is None or host in ("", "localhost"):
        return True
    try:
        return ipaddress.ip_address(str(host).split("%")[0]).is_loopback
    except ValueError:
        return False

def blocked(operation, host):
    with lock:
        observations["externalNetworkAttempts"] += 1
        if len(observations["networkAttempts"]) < 100:
            observations["networkAttempts"].append({"operation": operation, "host": str(host)[:255], "pid": os.getpid()})
        persist()
    raise PermissionError("External Python socket access is disabled for this native offline scenario")

# Allow Unix sockets/loopback used by local runtimes; reject external DNS/TCP/UDP.
original_getaddrinfo = socket.getaddrinfo
original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex
original_sendto = socket.socket.sendto

def getaddrinfo(host, *args, **kwargs):
    if not local(host): blocked("getaddrinfo", host)
    return original_getaddrinfo(host, *args, **kwargs)

def connect(self, address):
    if self.family != socket.AF_UNIX and isinstance(address, tuple) and not local(address[0]): blocked("connect", address[0])
    return original_connect(self, address)

def connect_ex(self, address):
    if self.family != socket.AF_UNIX and isinstance(address, tuple) and not local(address[0]): blocked("connect_ex", address[0])
    return original_connect_ex(self, address)

def sendto(self, *args):
    address = args[-1]
    if self.family != socket.AF_UNIX and isinstance(address, tuple) and not local(address[0]): blocked("sendto", address[0])
    return original_sendto(self, *args)

socket.getaddrinfo = getaddrinfo
socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.socket.sendto = sendto
record("worker-start", networkGuard="external Python DNS/TCP/UDP blocked; Unix/loopback allowed")
atexit.register(lambda: record("worker-exit"))
namespace = runpy.run_path(str(source), run_name="delulu_observed_worker")
Worker = namespace["Worker"]

def memory():
    mx = sys.modules.get("mlx.core")
    output = {"activeBytes": None, "peakBytes": None, "cacheBytes": None, "unavailable": []}
    for field, name in (("activeBytes", "get_active_memory"), ("peakBytes", "get_peak_memory"), ("cacheBytes", "get_cache_memory")):
        fn = getattr(mx, name, None) or getattr(getattr(mx, "metal", None), name, None)
        try:
            value = fn() if callable(fn) else None
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0: output[field] = value
            else: output["unavailable"].append(field)
        except Exception:
            output["unavailable"].append(field)
    return output

original_status = Worker.status
original_transcribe = Worker.transcribe

def status(self):
    result = original_status(self)
    result["nativeMemory"] = memory()
    result["nativeWorkerPid"] = os.getpid()
    record("status", loaded=bool(result.get("loaded")), memory=result["nativeMemory"])
    return result

def transcribe(self, request):
    result = original_transcribe(self, request)
    result["nativeMemory"] = memory()
    record("transcribe", memory=result["nativeMemory"], characters=len(str(result.get("text", ""))))
    return result

Worker.status = status
Worker.transcribe = transcribe
raise SystemExit(namespace["main"]())
