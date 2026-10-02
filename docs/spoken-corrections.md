# Spoken corrections

Enable **Spoken corrections** in Quick settings, or **Settings → Rewriting → Use spoken corrections**. It runs after prose dictation and vocabulary replacements, before clipboard delivery. The original speech remains in history (or the current session when history is off). Manual rewrite previews offer the same style.

The activation shortcut selects balanced memory, which runs speech and writing in turn. A local writing runtime/model is required; manage it under Models. Existing settings remain unchanged until activation. Technical dictation modes bypass automatic rewriting.

## Model choice

A sentence encoder produces representations for similarity/search, rather than resolving and editing arbitrary spoken corrections ([Sentence Transformers documentation](https://www.sbert.net/docs/sentence_transformer/usage/usage.html)). A fine-tuned token tagger could be smaller, but would require representative correction training data and evaluation.

This implementation reuses the existing local Qwen3.5 writing runtime. The 2B model is the practical starting point used for the native checks. It avoids another runtime/download for users who already have writing installed. The [official model card](https://huggingface.co/Qwen/Qwen3.5-2B) documents Transformers support and reports stronger instruction-following results for 2B than 0.8B; those general benchmarks do not establish correction accuracy. The existing 0.8B and 4B options remain available, but were not evaluated for this release. This is a choice for the existing app, not a claim to have benchmarked every model.

## Preserving words

The model proposes a JSON array of pairs: an exact earlier passage to remove and the later phrase that retracts/replaces it. The application validates unique matching spans, chronology, bounds, and non-overlap, then deletes them from the original string. It never inserts model-generated wording. Matching permits straight/curly quote variants without changing offsets. Quoted reported speech is protected, as are fenced/indented technical blocks. Repeated ambiguous spans, invalid plans, truncation or total cancellation stop automatic delivery; the original is retained for review. No text goes to a cloud service.

Unchanged passages keep their original words, punctuation and order. Spaces left at deletion boundaries are collapsed. Added assumptions and custom style instructions are disabled in this mode. For example:

> I want a new logo. Also remake this feature. Oh no, never mind, don’t do the logo.

becomes:

> Also remake this feature.

A deterministic span check cannot prove that a semantic deletion is correct. The model can miss corrections or choose the wrong target. Review consequential messages; the original is always recoverable. No universal accuracy or speed guarantee is implied.

## Verification notes

Live checks use the installed Qwen3.5-2B model through the actual worker, with synthetic dictation text. CPU generation avoids disrupting other GPU applications. Checks cover withdrawal of an earlier request, a replacement amount, preservation of unrelated/repeated wording, ordinary negative instructions, Dutch cancellation, complete cancellation and reported speech. Builds, existing automated checks, browser controls in both themes, and native GTK indicator previews complement inference checks. Physical microphone-to-other-app delivery is not part of these checks.
