"""Apply model-proposed deletions to the original dictation, never generated prose."""
import json
import re


class SpokenCorrectionError(ValueError):
    """Fixed, text-free cleanup diagnostics safe to send to the UI."""


def apply_spoken_corrections(source: str, proposed: str) -> str:
    try:
        edits = json.loads(re.sub(r"^```(?:json)?\s*|\s*```$", "", proposed))
        if not isinstance(edits, list) or len(edits) > 32:
            raise ValueError()
        spans = []
        # Length-preserving quote normalization keeps original deletion indices.
        quotes = str.maketrans("’‘“”", "''\"\"")
        comparable = source.translate(quotes)
        quoted = [match.span() for match in re.finditer(
            r'"[^"\n]*"|“[^”\n]*”|(?<!\w)\'[^\'\n]+\'(?!\w)|(?<!\w)‘[^’\n]+’(?!\w)', source)]
        for edit in edits:
            if not isinstance(edit, dict) or set(edit) != {"remove", "cue"}:
                raise ValueError()
            remove, cue = edit["remove"], edit["cue"]
            if not all(isinstance(value, str) and value.strip() for value in (remove, cue)):
                raise ValueError()
            remove, cue = remove.translate(quotes), cue.translate(quotes)
            if comparable.count(remove) != 1:
                raise ValueError()
            start = comparable.index(remove)
            if any(start < end and start + len(remove) > begin for begin, end in quoted):
                continue
            if comparable.count(cue) != 1 or not re.search(r"\w", cue):
                raise ValueError()
            cue_start = comparable.index(cue)
            if any(cue_start < end and cue_start + len(cue) > begin for begin, end in quoted):
                continue
            if start + len(remove) > cue_start:
                raise ValueError()
            spans.extend([(start, start + len(remove)), (cue_start, cue_start + len(cue))])
        spans.sort()
        for start, end in spans:
            if ((start > 0 and source[start - 1].isalnum() and source[start].isalnum()) or
                    (end < len(source) and source[end - 1].isalnum() and source[end].isalnum())):
                raise ValueError()
        if any(left[1] > right[0] for left, right in zip(spans, spans[1:])):
            raise ValueError()
        output = source
        for start, end in reversed(spans):
            output = output[:start] + output[end:]
        # Never collapse whitespace throughout unrelated content: indentation,
        # terminal commands and alignment must survive a spoken correction.
        output = output.strip() if spans else source
    except (ValueError, TypeError, KeyError):
        raise SpokenCorrectionError(
            "Cleanup could not identify exact corrections. Original saved for review; nothing sent."
        ) from None
    if not output.strip():
        raise SpokenCorrectionError("Nothing remains after spoken corrections. Original saved for review; nothing sent.")
    return output
