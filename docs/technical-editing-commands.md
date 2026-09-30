# Technical buffer keyboard commands

With the technical editor focused, Ctrl/Command + Alt provides four explicit actions:

| Key | Action |
| --- | --- |
| I | Preview replacement of the last complete identifier before the caret |
| W | Preview correction of the selected text, or the word at/immediately before the caret |
| Enter | Insert a newline using the draft's first existing line-ending style (LF for an empty draft) |
| P | Return the saved dictation mode to prose, retaining the draft |

The same actions have visible buttons. Replacement opens a preview of the exact target and an editable replacement; Cancel preserves draft text, and Replace requires confirmation. Each replacement uses the buffer's privately issued document/selection target. Changes to the draft or selection invalidate the preview; stale edits cannot overwrite newer content. A successful replacement is one undoable transaction. Originals in transcript history are never edited by these buffer actions.

Identifier selection is a Unicode lexical heuristic, not a language parser. It supports letter/underscore/dollar starts and kebab segments. A caret within an identifier is rejected instead of replacing a truncated token. Word selection handles straight/curly internal apostrophes. UTF-16 offsets cannot split surrogate pairs. Identifier replacements accept one identifier; word corrections preserve deliberately entered text.

Shortcuts are local to the editor, ignore repeat/composition/AltGraph input, and do not register global OS bindings. Prose switching waits until capture/model operations and settings saves are idle and reports failure without claiming a mode switch. An OS that intercepts a shortcut can use the corresponding button.

Dependencies: explicit modes/identifiers (#406/#417), literal buffer (#419), and range/version guard (#438). UNVERIFIED — unit/browser tests, builds, typechecks, formatting, native input and independent review were skipped per user instruction.
