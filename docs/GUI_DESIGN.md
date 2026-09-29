# Ocean console design

The application opens into its controls. The startup screen exposes microphone, language, shortcut and gesture, optional rewriting and personal correction, automatic paste, clipboard and history. These controls fit above the fold at both 1280×650 and 860×650 after first-run help is dismissed.

## Visual system

Deep navy surfaces, ocean-blue selection, cyan accents, cool readable text, thin panel borders and compact 5–9 px corners establish the identity. The sidebar remains navy in both themes. Light mode uses arctic blue/white working surfaces. Semantic tokens in `src/index.css` define surfaces, inputs, headers, text and feedback. Tailwind utilities handle component layouts; the sidebar and recording action also embed brand gradients/colors. Consolidating those remaining values belongs to future visual-system cleanup.

The working reference is [Tidal Console](design-concepts/01-tidal-console.png), with the light theme informed by [Current Workbench](design-concepts/02-current-workbench.png). [Abyss Studio](design-concepts/03-abyss-studio.png) is the third exploration. The generated images are visual references, not feature specifications; unsupported or duplicated controls were excluded. Prompts and generation method are recorded [alongside them](design-concepts/prompts.md).

## Layout and task hierarchy

- Navigation begins with Controls, Settings and Models; History and Audio files follow. Labels stay visible at normal compact desktop sizes.
- The persistent header contains one labeled Record/Stop action, current operation status, and theme switching. Missing engines route to setup.
- Three numbered configuration panels occupy the startup control deck. A latest-output inspector sits alongside them on larger windows and below them on compact windows. It exposes Result/Speech views, correction, copy and export without a full-width transcript feed.
- Settings starts with capture/delivery, followed by Personalization, Writing, Runtime and Application. Appearance is an application preference, not the first task on launch.
- Model selection uses compact comparison rows. The standalone Writing workspace has been removed. Rewriting opens beside transcript review with source, preview, apply, and undo. Its optional model is managed in Models. Audio files keeps operation, file and transcript controls next to its result.
- First-run setup is a dismissible inline notice, not a blocking introduction.

No promotional heroes, slogans, static waveforms, fabricated metrics or lifestyle copy belong in the working interface. Blank space is reserved for text editing and output, not illustration.

## Identity

`public/delulu-talks-icon.svg` is the source mark: an abstract ocean-blue speech current surrounding three voice pulses on a navy tile. A transparent mark and monochrome Mac tray templates accompany it; [brand masters and reproduction](BRAND.md) document the assets. PNG, ICO and ICNS application assets derive from this vector. The native overlay shares the ocean palette; live recording has a distinct coral state.

## Interaction checks

Shared controls retain visible focus, labels and native dialog behavior. Settings save through serialized patches. Writing style and writing enablement are independent. Microphones are enumerated on both Controls and Settings. Existing transcript originals remain intact beside corrections and delivered rewrites.

Browser regression checks cover priority controls above the fold, quick-setting persistence, both themes, compact layouts, correction and shortcut editing, source preservation, modal focus and real browser microphone capture. Desktop smoke verifies the sandboxed preload, real settings IPC, diagnostics and setup dialogs. Runtime installation and inference remain separate from visual styling.

Personalization lives in Settings and is reachable directly from Controls. Corrections and Text shortcuts have separate tabs and forms. Result review is shared across Controls, History, and imported audio, including rewrite preview/apply/undo, correction capture, copying, and export. Native speech options live with capture/delivery; optional rewriting settings have their own section.
