# Saved-rule phrase preview

Vocabulary includes a local test phrase field above the saved-rule list. It shows the original phrase, resulting clean text and each actual winning match in source order: rule kind/name, configured trigger, matched original spelling and exact replacement. Enabled corrections and text shortcuts participate together regardless of the selected list tab or search filter. Disabled rules and losing overlapping aliases are omitted. The field accepts a phrase up to 2,000 characters.

Preview and production personalization share enabled-rule enumeration and the same grouped Unicode-aware matching pass. Longest matching phrases win, existing first-rule priority resolves legacy conflicts, literal replacement bytes remain intact, and replacements never cascade. The explanation retains source offsets and the configured alias rather than guessing a rule from its replacement text.

Typing/testing does not save settings, invoke speech/rewrite workers or change transcripts. Explicit rule edits/toggles use the existing settings queue and refresh the result for the current phrase. The modal's existing single-draft preview remains available before saving a rule.

Unit fixtures verify actual owners/aliases, overlap/disabled/no-cascade behavior, Unicode folding across capture groups, repeated matches, exact blocks and unchanged source/rules; existing large-vocabulary production regressions still apply. The Chromium journey verifies the mixed saved-rule explanation, zero writes and unchanged history during testing, then explicit toggle/edit updates and a no-match result. These are deterministic/preview checks, not native recognition or model training evidence.
