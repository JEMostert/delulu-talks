"""Replay dictation samples (or the scripted prompts) through the rewrite model.

Samples come from a debug build started with DELULU_REWRITE_SAMPLES=<dir>
(src-tauri/crates/delulu-speech/src/rewrite_samples.rs). Each sample is matched
to the closest scripted prompt in prompts.json, which supplies the preset and
the expected result. Rewriting runs on the exact text the app sent; the Rust
protected-block splitting is not applied here.

Run offline with the installed rewrite runtime:
  "<profile>/magic-venv/generations/<id>/bin/python" -I \
    scripts/rewrite-eval/rewrite_eval.py backend/python samples .rewrite-samples
  ... rewrite_eval.py backend/python prompts        # scripted text, no audio
Options: --model qwen35Small|qwen35Medium|qwen35Large, --preset <id> (override),
--only <prompt id>, --cache-dir <hub dir>.
"""
import argparse, difflib, json, os, re, sys, time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("backend")
parser.add_argument("mode", choices=["samples", "prompts"])
parser.add_argument("directory", nargs="?")
parser.add_argument("--model", default="qwen35Large")
parser.add_argument("--preset")
parser.add_argument("--only")
parser.add_argument("--cache-dir", default=os.path.expanduser("~/.config/Delulu Talks/models/hub"))
args = parser.parse_args()
if args.mode == "samples" and not args.directory:
    parser.error("samples mode needs the samples directory")

sys.path.insert(0, args.backend)
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["DELULU_RUNTIME_KIND"] = "magic"
import clean_up  # noqa: E402
import transcription_engine as te  # noqa: E402

PROMPTS = json.loads((Path(__file__).parent / "prompts.json").read_text())


def words(text):
    return re.findall(r"\w+", text.lower())


def similarity(a, b):
    return difflib.SequenceMatcher(None, words(a), words(b)).ratio()


def closest_prompt(text):
    best = max(PROMPTS, key=lambda prompt: similarity(text, prompt["say"]))
    score = similarity(text, best["say"])
    return (best, score) if score >= 0.5 else (None, score)


def cases():
    if args.mode == "prompts":
        for prompt in PROMPTS:
            yield {"name": prompt["id"], "text": prompt["say"], "language": None}, prompt
        return
    for path in sorted(Path(args.directory).glob("sample-*.json")):
        sample = json.loads(path.read_text())
        prompt, _score = closest_prompt(sample["transcript"])
        yield {
            "name": path.stem,
            "text": sample["rewriteInput"],
            "transcript": sample["transcript"],
            "language": sample.get("language"),
            "appOutput": sample["rewrite"]["output"],
            "appError": sample["rewrite"]["error"],
            "appPreset": sample["rewrite"]["preset"],
        }, prompt


worker = te.Worker()
loaded = time.perf_counter()
worker.dispatch({"command": "magicLoad", "model": args.model, "cacheDir": args.cache_dir})
print(f"Loaded {args.model} on {worker.magic_device} in {time.perf_counter() - loaded:.1f}s\n")

results = []
for case, prompt in cases():
    if args.only and (prompt or {}).get("id") != args.only:
        continue
    preset = args.preset or (prompt or {}).get("preset") or case.get("appPreset") or "polish"
    request = {"command": "magicRewrite", "text": case["text"], "preset": preset, "instructions": "",
               "allowInferences": False}
    if case["language"]:
        request["sourceLanguage"] = case["language"]
    try:
        result = worker.dispatch(request)
        output, error, ms = result["text"], None, result["processingTimeMs"]
    except Exception as exc:  # noqa: BLE001 — report and keep going
        output, error, ms = None, f"{type(exc).__name__}: {exc}", None
    expected = (prompt or {}).get("expected")
    if isinstance(expected, list):  # several acceptable answers: compare with the closest
        expected = max(expected, key=lambda answer: similarity(output or "", answer))
    score = similarity(output, expected) if output and expected else None
    results.append({**case, "prompt": (prompt or {}).get("id"), "preset": preset, "output": output,
                    "error": error, "expected": expected, "score": score, "ms": ms})
    print(f"── {case['name']}  [{preset}]  prompt={(prompt or {}).get('id', 'unmatched')}")
    if case.get("transcript") and case["transcript"] != case["text"]:
        print(f"   heard:    {case['transcript']}")
    print(f"   input:    {case['text']}")
    print(f"   output:   {output if error is None else 'ERROR ' + error}")
    if expected:
        print(f"   expected: {expected}")
    if case.get("appOutput") or case.get("appError"):
        print(f"   in app:   {case.get('appOutput') or 'ERROR ' + str(case.get('appError'))}")
    marks = [f"{ms} ms" if ms is not None else None,
             f"similarity {score:.2f}" if score is not None else None,
             "exact" if output and expected and words(output) == words(expected) else None,
             "only fillers removed" if preset == "polish" and output == clean_up.strip_fillers(case["text"])
             and output != case["text"].strip() else None]
    print("   " + " · ".join(mark for mark in marks if mark) + "\n")

scored = [result["score"] for result in results if result["score"] is not None]
exact = sum(1 for result in results if result["output"] and result["expected"]
            and words(result["output"]) == words(result["expected"]))
errors = sum(1 for result in results if result["error"])
if scored:
    print(f"{len(results)} cases · {exact} word-exact · {errors} errors · mean similarity {sum(scored) / len(scored):.2f}")
if args.mode == "samples":
    out = Path(args.directory) / "results"
    out.mkdir(exist_ok=True)
    target = out / f"{time.strftime('%Y%m%d-%H%M%S')}-{args.model}.json"
    target.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    print(f"Results: {target}")
