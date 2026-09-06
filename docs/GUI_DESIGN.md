# Interface design

Delulu should feel like a quiet personal utility. The visual direction is warm and minimal: neutral green-tinted surfaces, a restrained green accent, readable text, soft borders and consistent rounded controls.

## Design system

- Colors are semantic CSS variables in `src/styles/tokens.css`, with system, light and dark appearance. The same components work in both themes.
- Body text uses the system sans-serif stack; transcript text is larger with generous line height. Uppercase labels are reserved for small section cues.
- Reusable primitives live in `src/components/ui`. Native `dialog` provides focus containment, Escape handling and focus restoration.
- All actionable controls have explicit focus indicators. Reduced-motion preferences disable decorative motion. Compact windows keep labels through accessible names/tooltips and reduce the sidebar to icons.
- Success notifications, persistent errors, busy buttons and setup progress are visually distinct. Setup-stage progress is explicitly described as stages rather than download bytes.

## Information architecture

Home, History and Magic are the daily workspace. Wordbook, Speech Lab and Models provide personalization and advanced tools. Settings sits at the bottom of the sidebar with General, Writing, Advanced and App & updates sections.

Home leads with recording and the active shortcut. Language and writing style are nearby; recent transcripts provide copy, review and paste-last recovery. Technical model/backend choices live outside the daily recording path.

Home and History share `TranscriptCard`. Corrections preserve the original. Remember a word is explicit and opens a short Wordbook form. A voice snippet is a Wordbook term with expansion text.

Magic keeps the rewrite button at the top of its controls. Source and result are separate, drafts survive navigation, and model settings are secondary. Model inference promises are phrased as user-controlled instructions rather than certainty.

Models uses selectable cards, an actionable setup banner and device diagnostics. Settings separates application updates from local model installation and repair. The recording overlay and desktop icon use the same warm palette.


## Identity

The SVG at `public/delulu-talks-icon.svg` is the source for application branding and desktop icon assets. It preserves the original orbital microphone concept: cyan voice, midnight-blue rounded hexagon, two clean orbital arcs. The icon's blue/cyan colors are identity colors; interactive controls continue to use the restrained green theme accent. Avoid glow filters and fine decorative marks so the microphone remains legible at small sizes.
