# Speech language control inventory

Before ARC-04, Controls and Settings independently consumed the global LANGUAGES list. The foundation removed the historical Qwen auto-only condition; both active platform R2T2 choices now preserve explicit language selection. Controls uses “Dictation language”; Settings uses “Language”. Both save the language setting and disable changes during saving or an active recording/model operation. Neither control changes the selected speech runtime.

Both controls now consume speechLanguageCapability(settings.model), with language choices and selection availability held by one typed descriptor. CUDA/PyTorch R2T2 and MLX R2T2 share the same current descriptor. Historical qwen3Asr records remain history data and are not active language-control choices. The descriptor does not change backend language handling or advertise new inference capabilities.

Unit checks cover both active identifiers and the unchanged language catalog. Browser preview fixtures verify Dutch/English choices, identical Controls/Settings options, bidirectional updates, reload persistence and preserved runtime identity for CUDA/MLX settings. These are UI and fixture contracts; no native inference evidence is claimed.
