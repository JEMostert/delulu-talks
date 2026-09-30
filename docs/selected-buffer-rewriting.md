# Keyboard rewriting of selected technical text

Select text in the existing technical buffer and press Ctrl/Command+Alt+R, or choose **Rewrite selection**. The existing local Qwen rewrite dialog previews only that explicitly selected range. Choose a style, generate a preview, review/edit it, then confirm to replace the captured range. No global shortcut or new writing workspace is created.

Selection offsets are mapped from textarea LF display positions to the exact raw buffer, preserving CRLF/lone-CR line endings and Unicode. Empty, whitespace-only, invalid or oversized selections are rejected. No clipboard, application document, editor symbols or background content is collected.

Applying uses the buffer's privately issued document and selection versions; changed or invalidated targets reject application. The original draft is retained in undo and transcript history is unchanged. Cancel, unavailable rewriting, generation failure and failed application leave the draft intact. Setup links to the existing Models page. Keyboard handling ignores repeats, IME composition and AltGraph, and the visible button remains available if the OS intercepts the key.

Native cross-application selected-text capture and replacement belong to their separate permission/focus workflows. This workflow operates only on an explicit selection inside the existing buffer. Technical block protection/optional context are implemented separately in #444; this PR does not claim native model fidelity or those unintegrated backend changes.

UNVERIFIED — unit/browser/Python tests, builds, typechecks, formatting, native keyboard/model inference and independent review were skipped per user instruction.
