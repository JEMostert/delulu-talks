# External integration event contract

`src/integrationEvents.ts` defines schema-version-1 event payloads for speech status, rewrite status and transcript availability. This contract is for future authenticated external integrations; the trusted app renderer keeps its existing IPC protocol. No network listener or permission grant UI is introduced here.

The event projector requires an active `events:status` grant. Missing or revoked grants produce no event. A transcript-available event includes only ID, time, model and source kind by default. Original, personalized, corrected and rewritten text appear only with the additional `transcripts:read` capability. Status events omit backend messages/details, which may contain source text or paths. Filenames, source paths and unknown future fields never pass through this explicit field allowlist.

A transport must look up the integration's current authenticated grant immediately before each delivery using the projector callback. Do not cache preprojected content in a subscriber queue: queue an event ID/reference and reproject at send time, including after reconnect or revocation. The payload function defines permissions but does not implement credential authentication, persistent grants, transport queue ownership or native selected-text permissions; those remain separate integration issues.

Unexecuted contract tests cover omitted content/future fields, explicit content access, revoked permissions, event permission independence and error-message exposure. UNVERIFIED — tests, builds, typechecks, formatting checks, browser checks and native checks were skipped per user instruction.
