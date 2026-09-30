# Local CLI and editor automation

Enable **Settings → Local data → Local automation** in the running desktop app.
The API listens on a randomly allocated `127.0.0.1` port. It uses bearer tokens,
rejects browser origins and unexpected Host headers, never follows remote routes,
and exposes no shell, clipboard, keyboard, or terminal execution endpoint.
Disabling it closes subscriptions and removes the connection file. The owner
token rotates on restart; scoped integration tokens remain until revoked.

Run `node scripts/delulu.mjs help`. `--connection` accepts the connection file
shown in Settings; normal installed and development profile paths are discovered
automatically. `--json` preserves structured output. `--output` creates a new
owner-only file and refuses to overwrite an existing destination.

```sh
node scripts/delulu.mjs status --json
node scripts/delulu.mjs transcribe /absolute/path/meeting.wav
node scripts/delulu.mjs batch /absolute/path/one.wav /absolute/path/two.flac --json
node scripts/delulu.mjs profiles
node scripts/delulu.mjs profile PROFILE_ID
node scripts/delulu.mjs export TRANSCRIPT_ID --output ./transcript.txt
node scripts/delulu.mjs rewrite --stdin < ./draft.txt
node scripts/delulu.mjs events
```

The owner connection file grants access to all owner commands. Give other tools
their own scoped token from Settings instead. Audio grants require explicit
allowed directories; real paths enforce those bounds even through symlinks.
Tokens are stored as hashes; the new token is shown only once. Revocation closes
that client's event subscriptions and blocks disclosure of awaited results.
Status events omit messages, paths, and transcript content unless separately
granted `transcripts:read`. Local user-data permissions remain the access boundary
on Windows; POSIX automation files use mode 0600 and their directory mode 0700.
Remote adapters are not configured by this API; speech and rewriting stay local.

## VS Code

The source extension is in `integrations/vscode`. For development, open that
directory in VS Code and launch it with the extension host; no dependency install
is needed. A package can be created separately with the owner's usual VS Code
extension tooling. Set `deluluTalks.connectionFile`, create a scoped token in
Delulu, and run **Delulu: Set Scoped Integration Token**. The extension uses
SecretStorage and deliberately does not use the owner token from the file.

Commands support profile switching, inserting the latest saved transcript,
transcribing a selected audio file, and previewing a rewrite of selected editor
text. Ctrl+Alt+R / Cmd+Option+R requests a selection rewrite. Optional editor context
sends document language and bounded symbol names only when enabled. Every edit
rechecks document identity, version, selection, and exact source text and creates
one editor undo operation. A changed destination rejects the edit. Rewriting
always previews before apply. No command sends Enter to a terminal.

These integrations were implemented through source inspection in the
consolidation pass. Local tests, builds, extension-host checks, and native model
execution were skipped at the owner's request; runtime validation is outstanding.
