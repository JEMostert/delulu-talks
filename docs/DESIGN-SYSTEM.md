# Deep Sea design system

Delulu Talks lives under water. The ocean is the stage and every piece of
interface is a glass instrument floating in it. This document is the contract
for styling the renderer; `src/styles/` implements it.

## Principles

1. **Calm water, bright instruments.** The background moves; the interface does
   not. Surfaces are quiet, rims are crisp, and accent color appears only where
   something is active, focused, or needs a decision.
2. **Depth is elevation.** Four layers, always in this order: the _abyss_
   (procedural ocean), the _sheet_ (a workspace panel), _cards_ inside the
   sheet, and _controls_ on cards. Each step up is slightly lighter and gets a
   brighter top rim. Never stack two cards with the same depth.
3. **Light comes from above.** Highlights sit on top edges (`inset 0 1px 0`),
   shadows fall down. Gradients run top-to-bottom.
4. **Bioluminescence is meaning.** Cyan (`current`) marks focus and selection,
   coral marks recording, sea-glass teal marks success, amber marks caution.
   Decorative glow is reserved for the record orb and the active dock item.
5. **One component, one look.** A button, field, tab strip, card, or badge looks
   the same on every page. Pages compose primitives; they do not restyle them.

## Themes

| Theme              | Water                                         | Glass                           | Ink                  |
| ------------------ | --------------------------------------------- | ------------------------------- | -------------------- |
| Dark — _Abyss_     | Deep navy with teal caustics and light shafts | Smoked navy glass, cool rims    | Foam white `#eaf6ff` |
| Light — _Shallows_ | Sunlit lagoon, pale aqua with white caustics  | Frosted white glass, white rims | Depth navy `#0a2540` |

Both themes share the pearl record orb and the same accent hue family. Text
contrast is verified at ≥ 4.5:1 for body and caption text on the surfaces it is
used on (`scripts/check-contrast.mjs`).

## Tokens

All tokens live in `src/styles/tokens.css` and are exposed to Tailwind through
`@theme inline` (`bg-surface`, `text-muted`, `border-line`, …).

- **Color roles:** `--canvas`, `--surface` (card), `--surface-soft` (nested
  well), `--surface-sheet`, `--input`, `--ink`, `--muted`, `--subtle`, `--line`,
  `--line-strong`, `--accent`, `--accent-hover`, `--accent-soft`, `--accent-ink`,
  `--on-accent`, `--success(-soft)`, `--warning(-soft)`, `--danger(-soft)`,
  `--record`.
- **Radius:** `--r-xs 6px` · `--r-sm 10px` (controls) · `--r-md 14px` (wells) ·
  `--r-lg 20px` (cards) · `--r-xl 28px` (sheet, dialogs) · `--r-pill 999px`.
- **Space:** 4px grid — 4, 8, 12, 16, 20, 24, 32, 40.
- **Type (Inter Variable, JetBrains Mono for code):** 11 micro · 12 caption ·
  13 control/body-small · 14 body · 16 section title · 20 page title ·
  26 display. Weights 400 / 500 / 600. Headings use −0.01em to −0.02em tracking.
- **Elevation:** `--shadow-1` controls, `--shadow-2` cards and popovers,
  `--shadow-3` sheet and dialogs; every raised surface adds `--rim-highlight`.
- **Motion:** `--ease-out cubic-bezier(.22,1,.36,1)`; durations `--t-fast 120ms`,
  `--t-base 200ms`, `--t-slow 320ms`. Hover lifts are at most 1px. All motion is
  removed under `prefers-reduced-motion`.

## Primitives (class contract)

| Primitive | Classes                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Buttons   | `primary-button`, `secondary-button`, `tool-button`, `danger-button`, `text-button`, `icon-button`; size modifier `.large`, `.compact` |
| Fields    | native `input`, `select`, `textarea`, `.field`, `.search-box`, `.field-error`                                                          |
| Switch    | `Toggle` → `.toggle`                                                                                                                   |
| Tabs      | `.page-tabs` (section tabs), `.segmented` (inline choice)                                                                              |
| Surfaces  | `.card`, `.settings-group` + `.group-heading`, `.setting-row`, `.well`                                                                 |
| Feedback  | `.alert` (+ `.info`, `.warning`, `.success`), `.badge`, `.progress-panel`, `.ocean-toast`, `.empty-state`                              |
| Structure | `.content-stack`, `.section-heading`, `.panel-toolbar`, `.panel-actions`, `.disclosure`                                                |
| Dialogs   | `Modal` → `.modal`                                                                                                                     |

Pages may add layout (grid, gap, order) with Tailwind utilities or a feature
stylesheet in `src/styles/features/`, but must not override a primitive's
colors, radius, border, or shadow.

## Shell

- **Home:** the ocean, the floating controller (copy · pearl orb · settings),
  one status line, and a glass _latest result_ card showing the last transcript
  with copy and open-in-history actions.
- **Recording:** the orb turns coral with a voice-level halo; the status line
  shows elapsed time and the silence countdown when auto-stop is armed.
- **Workspace:** a sheet rises above a compact dock. The sheet header shows the
  page title and subtitle, the command palette, and close. The dock carries the
  six destinations around the orb.
