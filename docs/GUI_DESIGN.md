# Desktop GUI design rationale

Research snapshot: 11 August 2026. The redesign follows desktop guidance rather than a landing-page pattern.

## Principles used

- [KDE's layout and navigation guidance](https://develop.kde.org/hig/layout_and_nav/) treats navigation as a chore to minimize and recommends a desktop structure built from a main content view, navigation sidebar, and contextual toolbar.
- [KDE's application-design guidance](https://develop.kde.org/hig/kde_app_design/) asks that the common path stay obvious while advanced capability remains available when needed.
- [KDE's status guidance](https://develop.kde.org/hig/status_changes/) favors quiet, actionable state changes over unnecessary success messages and decorative status color.
- [Microsoft's command-bar guidance](https://learn.microsoft.com/en-us/windows/apps/design/controls/command-bar) places the most common commands where they are always easy to reach and orders them by importance.
- [GNOME's header-bar guidance](https://developer.gnome.org/hig/patterns/containers/header-bars.html) keeps only a small number of context-relevant primary controls in the compact top region.

## Information architecture

```text
Work
  Dictation          immediate capture, output choice, latest result
  Speech Lab         file transcription, Verbatimize, forced alignment
  History            find, compare, copy, and export results

Configure
  Wordbook           persistent spelling and expansion rules
  Models & runtime   model choice, setup, residency, acceleration

Settings             lower-frequency global preferences
```

There is no Home destination. Launching the application opens Dictation, the highest-frequency task. Record/stop, the shortcut, and runtime status live in the global command bar instead of being repeated as page cards. The sidebar contains destinations only; contextual actions belong in each view's toolbar.

## Interaction rules

- Optimize for the repeated record → review → deliver loop; a capture does not require navigation.
- Use dense rows, split views, tables, and toolbars where the content is operational. Avoid marketing heroes, oversized headings, dashboard cards, gradients, and ornamental statistics.
- Keep model/runtime failure visible and actionable without competing with the Record command.
- Save Dictation quick controls immediately and silently. Reserve confirmations for transcript capture, copy/export, destructive actions, and explicit Settings saves.
- Preserve transcript truth: intended and verbatim remain parallel views. Wordbook changes are explicit exact-text rules, while delivery settings only choose which version leaves the app.
- Keep destructive actions visually distinct, require confirmation for environment/history removal, and provide text labels in addition to color and icons.
