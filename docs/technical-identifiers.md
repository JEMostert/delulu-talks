# Dictated identifiers

Open a transcript's details and choose **Identifiers** to preview explicit identifier commands independently of recognition. The preview starts with the preserved transcript and accepts edits without saving them to history. Copy the reviewed result explicitly. Existing speech, corrections and rewrite output remain available.

Commands have an explicit start and end:

- `camel case user account end identifier` → `userAccount`
- `pascal case user account end identifier` → `UserAccount`
- `snake case user account end identifier` → `user_account`
- `kebab case user account end identifier` → `user-account`
- `literal spelling capital A p i underscore two end identifier` → `Api_2`

`einde naam` also ends a command. Ordinary prose outside a command is preserved exactly. Case styles use whitespace-separated words, lowercasing words before applying the selected convention; acronym guesses are intentionally absent. Literal spelling accepts individual letters/digits, English/Dutch digit names, underscores, and explicit `capital`/`hoofdletter` letter instructions. Unrecognized words, invalid leading digits, punctuation, incomplete commands and oversized identifiers remain unchanged rather than guessing.

The pure `parseTechnicalIdentifier` and `renderIdentifierCommands` exports in `src/technicalIdentifiers.ts` are available to the explicit technical-mode grammar. Recognition remains R2T2; this parser never runs code, shell commands, models or automatic rewriting. This PR provides manual preview/copy, and does not enable automatic transforms or delivery. Native accuracy and comparison with vocabulary/rewrite pipelines remain separate evaluation work.

UNVERIFIED — unit/browser tests, builds, typechecks, formatting and native inference were skipped per user instruction.
