# Terminal command insertion

Delulu Talks inserts transcripts and accepted rewrite text through the clipboard
and the destination application's Paste action. It never sends Enter/Return to
execute a command. Review inserted terminal text and press Enter yourself when
you intend to run it. Copy-only delivery lets you choose when and where to paste.

Command-looking text stays clipboard data, including shell substitutions,
semicolons, Unicode, line breaks, and strings such as `{ENTER}`. It is never
interpolated into AppleScript or an input-injection command. The
current adapters send Command+V on Mac, Ctrl+V on X11, or the Ctrl+V
press/release sequence through the Wayland portal. Failed injection retains the
copied text and reports failure; it does not fall back to executing text.

A terminal or shell controls how it handles pasted line breaks. Some terminals
may execute pasted multiline text without a separate Enter keypress. Delulu does
not inspect the destination or guarantee bracketed-paste behavior. Use copy-only
delivery and inspect the clipboard text before pasting commands when this matters.

`cargo test -p delulu-desktop paste` checks the injection routes (Wayland
portal key release, KDE Klipper publication, macOS accessibility) and the
failure/clipboard-only paths. Clipboard, subprocess, and portal calls are mocked; the suite neither runs shell text nor proves native
desktop focus, terminal paste behavior, or successful delivery.
