# Personal profile contract v1

`AppSettings.personalProfiles` stores a JSON document with `schemaVersion: 1` and
`profiles: PersonalProfileV1[]`. Each entry also has `schemaVersion: 1`, a unique
nonblank `id`, and a nonblank `name`. The contract and reader live in
`src/personalProfiles.ts`.

The Profiles settings tab saves named current-settings snapshots or starters for
code, terminal commands, Dutch/English messages, long notes and imported recordings.
Saved profiles can be renamed or deleted. These operations do not activate a
profile or change current language/delivery/vocabulary/rewrite settings. Activation,
automatic selection, context capture and runtime decode control remain separate
work. There is no persisted active profile in this schema.

| Field | Contract |
| --- | --- |
| `language` | A supported configured recognition language code, not detected language. |
| `decode` | `backend-default`, or `explicit` with finite `temperature` in 0–2 and integer `maxTokens` in 1–32768. These express desired controls; future activation must check actual backend support and must not silently ignore unsupported controls. |
| `delivery` | Boolean `autoPaste`, `copyToClipboard`, and `keepHistory`. |
| `vocabulary.rules` | Up to 500 uniquely identified corrections/shortcuts, with exact `term`, `soundsLike`, `replacement`, `enabled`, and optional language code. Omitted language means all languages; invalid language rejects the document. Saved block whitespace is retained. |
| `technicalGrammar` | Boolean `preserveIdentifiers` and up to 500 nonblank `literalTerms`. Future activation must connect these to the technical protection workflow. |
| `context` | `none`; `manual` text with capture/session scope; or `native` with capture scope, an explicit list of foreground-app/window-title/selected-text sources, and `requiresExplicitPermission: true`. The profile grants no native permissions. Activation must obtain runtime authorization and honor capture scope. |
| `rewrite` | Boolean enabled, Qwen rewriting model ID, existing preset, boolean allowInferences, optional instructions. Independent from R2T2 recognition. |

`personalProfileFromSettings` produces a validated snapshot for future consumers;
it neither stores nor activates it. Defaults are backend decoding, identifier
preservation, no literal terms, and no context. Snapshotting copies current
language/delivery/vocabulary/rewrite settings without changing those settings.

Missing profile data is migrated to an empty v1 collection. Invalid current-schema
data throws before a settings write instead of truncating or removing profiles.
Limits are 128 profiles, 5 MB of JSON, and nesting depth 40. Unknown extra fields in
validated v1 documents are retained without reconstructing the document.

A newer collection version or a newer entry version is preserved as an opaque
read-only document. `readPersonalProfiles` reports `status: unsupported`; consumers
must not interpret or activate it. Unrelated settings saves retain it. Settings
update boundaries reject replacing/removing it or introducing unsupported schema
data. Loading never downgrades newer profiles. JSON formatting may change on an
ordinary settings save, but profile values and unknown fields are retained.

Later creation/activation workflows must surface a concrete profile change and
check decode, technical grammar, and native context capabilities before applying
it. This contract alone makes no inference, device, native context or activation
verification claim.

Management uses the serialized `profiles:manage` IPC boundary, reading the latest
stored settings for each operation. Creation snapshots vocabulary as-is; starters
request no context, preserve identifiers and use backend decode defaults. Code and
terminal starters disable rewriting and automatic paste; messages choose Dutch or
English and polish; notes choose history/copy with structured rewrite style; imports
choose history/copy without automatic paste. Optional rewriting remains enabled
only where inherited from current settings. Creation does not import or execute
anything. The form previews the actual stored settings before saving.

Commands reject empty/oversized names, duplicate names (Unicode-normalized and case
insensitive), missing profile IDs, unknown starters, future schemas and collection
limits. Rename/delete preserve the document's remaining unknown fields and rule
text. Deletion requires confirmation in the UI; failed operations retain drafts.
