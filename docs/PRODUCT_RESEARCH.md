# Current dictation workflow decision — 7 September 2026

The 0.8 workflow uses native intended transcription by default, with Qwen available on demand and automatic rewriting off. Corrections and exact text shortcuts produce a separate result; the model transcripts and timing remain immutable. Existing entries migrate without deletion, and legacy spelling-only entries ask for a recognized phrase.

Evidence checked against primary sources:

- [CrisperWhisper style control](https://nyra-labs.com/research/multilingual-style-control): native intended and verbatim output make separate LLM cleanup unnecessary for normal dictation.
- [CrisperWhisper API](https://github.com/nyrahealth/CrisperWhisper/blob/main/DOCS.md): dual batching requires CT2; our Transformers path uses separate decodes. Standard models are not trained for hotword boosting. Timings and longform transcription do not establish a streaming UI.
- [Flow dictionary](https://docs.wisprflow.ai/articles/4052411709-teach-flow-your-words-with-the-dictionary) and [snippets](https://docs.wisprflow.ai/articles/5784437944-create-and-use-snippets): recurring spelling mistakes and reusable blocks represent different user intentions.
- [Superwhisper modes](https://superwhisper.com/docs/modes/modes): plain voice-to-text can operate without AI transformations.
- [Flow transforms](https://docs.wisprflow.ai/articles/2719941210-how-to-configure-polish-shortcuts-and-custom-prompts): explicit transformations provide useful access to rewriting without making it a prerequisite for every utterance.

Validation includes real local Electron inference and Qwen rewriting with automatic rewriting off, exact shortcut preservation, apply/undo, original-preserving corrections and export. The short audio smoke sample is not an accuracy benchmark. Broad natural-speech evaluation, streaming previews, and application-aware profiles remain future work rather than advertised capabilities.

---

# Earlier product research and direction

Research snapshot: 11 August 2026. Sources are the vendors' own product pages and repositories.

## Market baseline

| Product | Publicly documented strengths | Delulu Talks response |
| --- | --- | --- |
| [Wispr Flow](https://wisprflow.ai/features) | Cross-app dictation, automatic cleanup, snippets, personal dictionary, styles, context, developer formatting, and broad language support | Global shortcut/paste, intended cleanup, deterministic expansions, explicit language/model controls, all local |
| [Wispr Flow context](https://wisprflow.ai/context) | Uses surrounding content and optional screen context to tune output | Delulu stays screen-blind by design today; privacy is predictable and no unrelated app content is captured |
| [Superwhisper modes](https://superwhisper.com/docs/modes/modes) | App/site modes, custom AI instructions, system audio, speaker workflows, and context-aware processing | Dual transcript modes are model-native and deterministic; context/LLM rewriting remains an optional future layer, never part of the speech truth |
| [Superwhisper vocabulary](https://superwhisper.com/docs/get-started/interface-vocabulary) | Recognition vocabulary plus reliable post-transcription replacements | Standard Nyra weights do not safely support hotword hints, so Delulu implements the reliable replacement half and labels the limitation honestly |
| [VoiceInk](https://github.com/Beingpax/VoiceInk) | Open-source local dictation, modes, contextual awareness, custom commands, and model choice | Cross-platform Electron shell, local Crisper engine family, vocabulary rules, history, model lifecycle, and Speech Lab |
| [OpenWhispr](https://github.com/OpenWhispr/openwhispr) | Open-source cross-platform dictation, local/cloud choice, meetings, diarization, notes, audio import, agents, API/MCP | Delulu takes the focused local specialist position: no accounts or cloud, but unusually rich verbatim fidelity, alignment, paired transcripts, timing, and export |
| [Superwhisper Meeting](https://superwhisper.com/docs/modes/meeting) | Meeting recording, summaries/action items, and optional speaker separation | Meeting/system-audio capture and diarization are the largest remaining competitive gap; they should be a separate subsystem instead of being faked with a single-speaker ASR model |

## Why CrisperWhisper is the product edge

[Nyra's official CrisperWhisper repository](https://github.com/nyrahealth/CrisperWhisper) exposes capabilities that generic cleanup-first dictation products do not treat as first-class primitives:

- intended versus verbatim decoding rather than destructive cleanup after transcription;
- CT2 dual decoding, producing both views in one batched pass;
- approximately 30 ms word boundaries and forced alignment;
- Verbatimize, which reconstructs audible disfluencies from audio plus a trusted clean transcript;
- conditional-continuation long-form decoding with boundary protection;
- hallucination-loop repair and temperature fallback;
- output-preserving strict speculative decoding for Large with Turbo as draft.

The 2.0 rework turns those primitives into user features: paired history, selectable paste output, speaking insights, subtitle export, a word timeline, Verbatimize, forced alignment, and model-residency/acceleration controls.

## Implemented competitive system

| User need | Implementation |
| --- | --- |
| Instant access | Portal-aware system shortcut, tray action, resident-model default, focus-free overlay |
| Fast local inference | CT2 Auto on Linux x64, FP16 CUDA selection, Large/Turbo speculative path, persistent worker |
| Clean text without losing truth | Intended + verbatim default, per-result tabs, selectable paste variant |
| Imported recordings | Speech Lab accepts common audio/video formats and uses FFmpeg normalization where needed |
| Precision workflows | Per-word timing, interactive word timeline, forced alignment, SRT/VTT/JSON/TXT export |
| Personal terminology | Case-insensitive aliases and deterministic expansions without unsupported standard-model hotword prompting |
| Feedback on speaking | Local filler, repetition, cut-off, vocal-event, pace, and speaking-time insights |
| Privacy/control | Local inference, no telemetry, temporary audio deletion, optional history, isolated runtime reset |
| Hardware choice | Small/Medium/Turbo/Large catalog, backend and compute controls, load/unload/preload toggle |
| CachyOS/KDE | Chromium audio stack, Electron Wayland shortcut portal, pacman package target, layered Linux paste detection |

## Next product bets

These should follow the same local-first and evidence-honest design:

1. **Meeting capture as a separate pipeline:** PipeWire system audio, dual-channel mic/system capture, a local diarizer, live segment storage, and optional local summary generation. CrisperWhisper remains ASR; it should not be presented as a diarizer.
2. **App-aware output profiles:** opt-in application identity only, with local deterministic formatting profiles before any LLM is considered. Screen capture remains off by default.
3. **Streaming preview:** incremental local segments during capture, clearly marked provisional, while the final Crisper pass remains authoritative.
4. **Command palette and transformations:** user-defined offline actions over selected text/transcripts, isolated from the raw transcript record.
5. **Runtime resilience:** signed/checksummed helper downloads, GPU-to-CPU fallback, model storage management, and first-run hardware benchmarking.
6. **Accessible onboarding:** interactive shortcut conflict checks, microphone level testing, paste-capability setup, and a license/runtime readiness checklist.

The architectural rule is that transcription truth, optional transformation, and delivery remain separate. That keeps new convenience features from corrupting the verbatim record or weakening the privacy promise.
