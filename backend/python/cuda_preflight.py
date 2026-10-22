"""Check the installed CUDA runtime before downloading speech model weights."""


def ensure_cuda_compatible(torch=None) -> dict:
    """Probe one CUDA float32 operation; this does not prove model inference."""
    if torch is None:
        try:
            import torch as torch_module
        except Exception as error:
            raise RuntimeError(
                "Could not import PyTorch for the speech CUDA preflight. "
                "Use Repair for the speech runtime, then load the speech model again. "
                f"Cause: {error}"
            ) from error
        torch = torch_module

    torch_version = "unknown"
    cuda_version = "unavailable"
    stage = "checking the PyTorch CUDA build"
    tensor = None
    try:
        torch_version = str(torch.__version__)
        installed_cuda = torch.version.cuda
        if not isinstance(installed_cuda, str) or not installed_cuda.strip():
            raise RuntimeError(
                "The installed PyTorch build has no CUDA runtime. "
                "Speech requires a CUDA build of PyTorch."
            )
        cuda_version = installed_cuda.strip()

        stage = "checking CUDA availability"
        if not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA is unavailable to PyTorch. Check that an NVIDIA GPU "
                "and a compatible NVIDIA driver are available to this process."
            )

        stage = "initializing CUDA"
        torch.cuda.init()
        device_index = int(torch.cuda.current_device())
        device_name = str(torch.cuda.get_device_name(device_index))
        capability = torch.cuda.get_device_capability(device_index)
        compute_capability = [int(capability[0]), int(capability[1])]

        stage = "running the CUDA float32 round-trip probe"
        tensor = torch.tensor(
            [1.0], dtype=torch.float32, device=f"cuda:{device_index}"
        )
        tensor.mul_(2.0)
        result = tensor.item()
        torch.cuda.synchronize(device_index)
        if result != 2.0:
            raise RuntimeError(
                f"The CUDA float32 round-trip returned {result!r}; expected 2.0."
            )

        return {
            "torchVersion": torch_version,
            "cudaRuntimeVersion": cuda_version,
            "deviceIndex": device_index,
            "deviceName": device_name,
            "computeCapability": compute_capability,
            "probe": "cuda-float32-roundtrip",
        }
    except Exception as error:
        raise RuntimeError(
            f"Speech CUDA preflight failed while {stage} "
            f"(PyTorch {torch_version}; CUDA runtime {cuda_version}). "
            "Check or update the NVIDIA driver for this CUDA runtime, "
            "then use Repair for the speech runtime and load the speech model again. "
            f"Cause: {error}"
        ) from error
    finally:
        # Release only this probe's tensor; do not flush other CUDA allocations.
        tensor = None
