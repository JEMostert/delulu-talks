# Runtime dependency inventory

New speech and optional Qwen 3.5 Magic installations record their dependencies separately in every candidate generation:

```text
<runtime-root>/generations/<generation>/runtime-speech-inventory.json
<runtime-root>/generations/<generation>/runtime-magic-inventory.json
```

Only the file for that generation's runtime kind is written. The existing `runtime-<kind>-installed.txt` pip freeze report remains alongside it. Existing generations and legacy environments are not modified or backfilled.

The JSON report uses `schemaVersion: 1` and records:

- `createdAt`: UTC observation time.
- `runtime`: manifest revision, runtime kind, generation, backend engine and device selection preference, plus the target Electron platform and architecture.
- `requested`: each executed pip installation stage, its exact direct requirement strings and pip arguments, and the path and full contents of any constraint file actually passed to pip. Installer pins, Windows CUDA wheel pins and the main runtime request remain distinct, including overlapping requirements. Git requirements retain their source revision; extras retain their spelling.
- `observed.interpreter`: the candidate's executable, Python version and full version string, implementation, virtualenv and base prefixes, Python platform, OS system/release, machine architecture and pointer size.
- `observed.distributions`: the names and resolved versions of **all** distributions visible to that candidate Python, including installer tools and transitive dependencies; `distributionCount` records their count. Names and versions come from `importlib.metadata`, retaining the installed metadata spelling rather than deriving them from requests or another platform's lock file.

Speech records MLX Audio with Metal on Apple Silicon, or Transformers with CUDA (CPU for Nemotron when requested or when the GPU is full) on Linux and Windows. Magic records Transformers with the worker's CUDA-then-MPS-then-CPU device preference, including on Mac; it is independent of MLX speech. These fields describe the selected backend and its device policy. They do not assert observed GPU capability, model compatibility or successful native inference. The observed interpreter platform and machine are separate from the requested target.

After package installation, `pip check`, backend readiness and the existing pip freeze report, the installer runs a bounded, read-only probe using the **candidate virtualenv's Python**. The probe imports only Python standard library modules, enumerates distribution metadata and disables bytecode writes. It does not import installed model libraries, inspect model weights, download packages, or execute inference. The report is a local dependency inventory; artifact verification is recorded separately as described below. It does not establish a license audit or native inference validation.

The installer rejects malformed or truncated JSON, missing interpreter fields, observations from a different virtualenv, missing distribution names/versions, incomplete counts and ambiguous duplicate distribution names. It writes the validated report through a restricted temporary file and rename **before** switching the runtime's active pointer. Probe, validation, write or cancellation failures leave the previous interpreter, generation and activation pointer intact. A failed candidate remains inactive for the existing recovery workflow.

Verification covers actual metadata enumeration in a disposable standard-library-only virtualenv with direct and transitive distribution metadata and package import traps. Mocked installation tests check Linux/Apple Silicon/Windows stage selection, applied constraints, actual observation preservation and failure recovery. Those simulated platform tests do not establish Mac or Windows hardware support. Native inference still requires evidence on the relevant hardware.

## Downloaded artifact hashes

Before each installation stage, pip resolves the request with `--dry-run --report`. The candidate generation retains `runtime-<kind>-<stage>-artifacts.json` (pip's source report) and `runtime-<kind>-<stage>-artifacts.txt` (the exact resolved install requirements). Each inventory stage also records `resolverArguments`, `artifactRequirements` and `artifacts`, including package name/version, source URL, all available archive hashes and the verification method.

Installation uses the resolved artifact URLs with the strongest supported reported hash in each URL fragment. Pip verifies downloaded bytes against that digest before unpacking/installing the artifact, including cached downloads. `--no-deps` prevents a fresh dependency resolution from silently substituting unrecorded runtime packages; transitive packages from the resolver report are included explicitly. Empty reports mean that the stage's requests are already satisfied by the candidate.

Git sources record and install their resolved immutable commit. Pip cannot provide an archive digest for a Git checkout, so these entries use `vcs-commit` rather than claiming archive verification. Archives without a supported digest explicitly use `hash-unavailable`; no digest is invented or presented as publisher-authenticated. Hash expectations come from the configured package index/report over the existing transport, rather than an independently signed release manifest. Model weights, the externally supplied base Python/venv bootstrap, and isolated source-build dependencies are outside this runtime artifact report.

Malformed reports, invalid hashes, unsupported sources, hash mismatches, failed downloads and installation failures stop the candidate before activation and preserve the existing runtime. Source metadata resolution can execute build hooks, and source installs can fetch isolated build dependencies; this mechanism verifies available runtime archive hashes and is not a complete offline build lock. UNVERIFIED: checks for this artifact flow were not run per the current user instruction.
