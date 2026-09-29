# Models setup behavior inventory

Recorded before the ARC-08 extraction against merged foundation commit bb78073. Models composes three existing responsibilities: speech lifecycle, optional rewrite lifecycle/selection, and diagnostics on initial mount and explicit refresh. App supplies operations and global busy state; backend ownership stays in AsrService.

| State / interaction | Speech setup | Optional rewriting |
| --- | --- | --- |
| Missing engine | Install engine; migration flag offers Update setup | Install rewriting |
| Unloaded engine | Load model and Repair engine | Load rewriting and Repair rewriting |
| Ready engine | Unload and Repair engine | Unload rewriting and Repair rewriting |
| Any active recording, setup, load, transcription, or rewrite | Lifecycle controls disabled through App busy | Lifecycle controls and selection disabled through App busy |
| Settings saving | No model selector | Selector disabled until save completes |
| Model selection | Platform-selected R2T2 metadata; no alternate speech selector | Qwen 3.5 selection saves magicModel through existing settings callback |
| Setup/load progress | Preparing/loading phases show setup-stage progress and backend detail | Preparing/loading phases show setup-stage progress and backend detail |
| Error | Backend message with an explicit repair action | Backend message with an explicit repair action |
| Diagnostics | Separate Diagnostics component loads when first mounted and on Refresh | Same diagnostics, no separate request ownership |

Behavior corrections accompanying extraction: either an error phase or an error engine should expose the repair alert in both sections; rewrite inference must not be labeled as model setup-stage progress. Existing speech error treatment looked only at phase, rewrite error treatment only at engine, and rewrite progress also included inference. Setup percentages describe stages, never download bytes. Unknown progress remains indeterminate.

The extracted SpeechSetup and RewriteSetup receive their own typed props. ModelSetupStatus is shared by those two real callers for setup progress, backend detail, error messages and repair actions. ModelsPage only composes these sections with Diagnostics. Transcript rewrite preview/apply/undo, settings residency, and native inference remain owned by their existing components/services.

Verification uses mocked desktop IPC browser fixtures for button calls, busy/error/progress states and model selection. Native runtime downloads and inference are outside these renderer checks.
