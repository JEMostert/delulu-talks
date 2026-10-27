# Usability review (v0.5.0)

A pass over the whole interface from the user's side: can someone find a
feature, turn it on and see it work without knowing how the app is built?
Findings are graded Broken (the task silently fails), Medium (it works, but
people get lost) or Low.

## Findings

### Broken

1. **Rewriting is installed in one place and switched on in another.**
   Engines → Rewriting downloads and loads the model and then shows _Ready_
   with an _Unload_ button, but nothing happens to your dictation: the
   switch that applies it lives in Settings → Rewriting (or Quick settings).
   The model sits in memory and is never used.
2. **Sonar depends on three switches in three places.** Sonar answers through
   Siren, which refuses agent speech while _Speak replies aloud_ is off, and
   agents only reach Sonar while _Let coding agents speak_ (inside the
   collapsed _Connect agents_) is on. With either off, Sonar starts, hears
   you and never answers.
3. **Navigation is hidden.** On Home the only way to reach any page is the
   gear, which opens Quick settings and only then reveals the dock. Dock
   icons have no labels, and the names they hide (Bottles, Lingo, Engines)
   do not say what is behind them.
4. **Imported files waited in a paused queue.** Adding files in Bottles
   paused the import queue, so nothing transcribed until you found and
   pressed _Resume_ on the Queue card.

### Medium

5. **The same control in two or three places.** Speech size (Engines and
   Settings → Speech), rewrite model (Engines and Settings → Rewriting),
   load/unload/repair (Engines and Settings → Advanced), microphone (Quick
   settings, Settings, Siren), language (Quick settings, Settings, Engines →
   Decoding), theme and _Keep speech ready_ (Quick settings and Settings).
6. **Maintenance buttons as primary actions.** _Unload_, _Load_ and _Repair_
   sit next to every healthy engine. Models load on demand and unload when
   idle, so these invite "is it running? do I need to press Load?".
7. **Bottles lists the same files twice:** a Queue card and a Files list,
   each with its own states and buttons, plus a transcript card that
   duplicates the Logbook.
8. **The rewrite dialog buries its main action.** _Generate preview_ sits
   below style, instructions, a character counter, Clear, context, an
   example and two text boxes, and the style ignores the one chosen in
   Settings.
9. **Siren previews were blocked by the master switch**, although the app's
   own previews are allowed to speak while Siren is off.

## Patterns applied

- **Visible, descriptive navigation.** Hidden navigation measurably lowers
  discoverability and slows people down (Nielsen Norman Group). Labels
  should predict the destination; feature brands stay inside the pages.
  Wispr Flow's hub uses the same plain sidebar: Home, Dictionary, Snippets,
  Style, Settings.
- **One place per feature, organised by task.** A feature's switch, its
  model download and its options sit together, top to bottom in the order
  you need them. Superwhisper keeps model downloads with the modes that use
  them and downloads on first use.
- **Progressive disclosure.** Everyday options are visible; maintenance
  (load, unload, repair, runtimes, caches, diagnostics) moves to Advanced.
- **Show prerequisites where they block.** A feature that cannot start says
  what is missing and offers the button that fixes it.

## What changed

| Before                                      | After                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Dock only after opening Quick settings      | Labeled dock always visible: History · Words · record · Voice · Settings  |
| Quick settings sheet                        | Removed; its controls live in Settings                                    |
| Engines page (Speech, Rewriting, Runtime)   | Settings → Dictation, Settings → Rewrite and Settings → Advanced          |
| Rewrite: install in Engines, on in Settings | One Rewrite card: set up, then _Rewrite every dictation_, style and model |
| Load / Unload / Repair on every card        | Settings → Advanced (Repair still shows inline when setup fails)          |
| Logbook, Bottles, Lingo, Siren              | History (with file import), Words, Voice (Siren and Sonar inside)         |
| Bottles queue and file list                 | One file list in History; drop files anywhere on History                  |
| Siren master switch + agent switch          | One Siren switch that also opens the agent connection                     |
| Sonar fails silently without Siren          | Sonar lists what it still needs, with a button for each                   |
| Rewrite dialog with Generate at the bottom  | Style and Rewrite at the top; extras under _More options_                 |

Page ids (`models`, `lab`, ...) stay valid over IPC: `models` opens
Settings → Dictation, `rewrite` opens Settings → Rewrite and `lab` opens
History.
