#!/usr/bin/env python3
"""Compare the app's Whisper harness with CPU NeMo-Speech.cpp on one corpus.

Corpus: manifest.json containing {id, reference, source}, plus <id>.wav files
(16 kHz mono PCM16). No downloads or external audio uploads are performed.
"""

import argparse
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import unicodedata
import wave


def words(text):
    return "".join(
        " " if unicodedata.category(c)[0] in "PS" else c
        for c in unicodedata.normalize("NFKC", text).lower()
    ).split()


def errors(reference, hypothesis):
    ref, hyp = words(reference), words(hypothesis)
    previous = list(range(len(hyp) + 1))
    for i, a in enumerate(ref, 1):
        current = [i]
        for j, b in enumerate(hyp, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (a != b)))
        previous = current
    return {"word_errors": previous[-1], "reference_words": len(ref)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--whisper", type=Path, required=True)
    parser.add_argument("--nemo", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, default=2)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")
    cases = json.loads((args.corpus / "manifest.json").read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    paths = [(args.corpus / (case["id"] + ".wav")).resolve() for case in cases]
    command = [str(args.whisper.resolve()), "large-v3-turbo-q5_0",
               *map(str, paths * args.repetitions)]
    with (args.output / "whisper.stderr").open("w") as stderr:
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                                stderr=stderr, check=True)
    (args.output / "whisper.stdout").write_text(result.stdout)
    whisper = {}
    for line in result.stdout.splitlines():
        parts = line.split("\t", 3)
        if len(parts) == 4:
            name, language, latency, text = parts
            whisper.setdefault(name, []).append({"language": language,
                "latency_ms": int(latency.removesuffix(" ms")), "text": text})

    # The directory contains only manifest-selected files, excluding raw inputs.
    with tempfile.TemporaryDirectory(prefix="delulu-stt-corpus-") as temporary:
        for path in paths:
            (Path(temporary) / path.name).symlink_to(path)
        command = [str(args.nemo.resolve()), "bench", "asr", temporary,
            "--model", str(args.model.resolve()), "--device", "cpu",
            "-c", "1", "-n", str(args.repetitions), "--warmup", "1",
            "--asr.salm.max_sequences", "1",
            "--asr.salm.n_ctx_per_sequence", "4096",
            "--asr.salm.max_context", "4096", "--asr.salm.mtp_draft", "0",
            "--asr.salm.n_batch", "512", "--asr.salm.encoder_max_batch", "1",
            "--asr.salm.max_new_tokens", "256", "--asr.backend.threads", "8",
            "--save", str((args.output / "transcripts").resolve()), "--json"]
        (args.output / "nemo-command.json").write_text(json.dumps(command, indent=2))
        with (args.output / "nemo.stderr").open("w") as stderr:
            result = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                                    stderr=stderr, check=True)
        (args.output / "nemo.json").write_text(result.stdout)
    nemo_results = json.loads(result.stdout)
    nemo_inputs = {
        Path(item["name"]).name: item
        for item in nemo_results["runs"][0].get("inputs", [])
    }
    summary = []
    for case, path in zip(cases, paths):
        with wave.open(str(path)) as audio:
            duration = audio.getnframes() / audio.getframerate()
        runs = whisper[path.name]
        transcript = args.output / "transcripts" / (path.stem + ".txt")
        text = transcript.read_text().strip()
        summary.append({**case, "audio_seconds": duration,
            "whisper": {"runs": runs,
                "median_ms": statistics.median(r["latency_ms"] for r in runs),
                **errors(case["reference"], runs[0]["text"])},
            "nemotron_cpu": {"text": text,
                # Some NeMo releases report only corpus-wide latency.
                "latency_ms": nemo_inputs.get(path.name, {}).get("latency_ms"),
                **errors(case["reference"], text)}})
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2,
                                                          ensure_ascii=False) + "\n")
    print(args.output / "summary.json")


if __name__ == "__main__":
    main()
