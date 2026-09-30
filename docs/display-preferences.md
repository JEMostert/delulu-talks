# Display preference verification

Status: **UNVERIFIED — no display/browser/native checks run per user instruction.**

The renderer already disables CSS animation, transitions and smooth scrolling for
`prefers-reduced-motion`. The native GTK recording indicator now follows
`gtk-enable-animations`, including changes while it is running. Reduced motion
disables decorative beacon/idle-meter animation and uses a static busy glyph.
Actual microphone levels and the duration clock remain live information.

For a later authorized native preview (requires the existing GTK dependencies):

```sh
python3 electron/overlay/pill.py --preview listening --reduced-motion
python3 electron/overlay/pill.py --preview transcribing --reduced-motion
```

The forced switch applies only to preview mode. Normal operation follows the
desktop preference. Reduced-motion preview files have a `-reduced-motion.png`
suffix, so they do not replace normal-motion previews.

`tests/e2e/display-preferences.pw.ts` contains unrun browser fixtures for compact
540×760 windows, 1×/1.25×/1.5× device scale, reduced motion and 18px control text.
These simulated settings are not evidence about the owner's displays or native
font scaling. They check that Stop stays reachable, decorative motion is absent,
content does not overflow horizontally, and keyboard model navigation remains
available. No microphone/model operation is executed by the fixture.

The owner-display pass remains pending on Linux, Windows and Mac. Record OS,
display resolution/scaling, text preference, app zoom, animation preference,
actual window size and exact app SHA. Cover capture/Stop, model setup, transcript
review, profile confirmation and the recording indicator. Label screenshots as
browser fixture, native preview or installed native app; do not treat screenshots
alone as inference, permissions or delivery evidence.
