# Unicode and multiline delivery fixtures

`tests/fixtures/delivery-text.json` contains eight invented exact strings: CRLF/newlines/indentation, emoji skin-tone/ZWJ/variation sequences, precomposed and combining forms, Japanese/Chinese/Korean, Arabic/Hebrew/mixed direction, directional marks, non-ASCII spaces and literal command syntax. Every fixture is data, never an instruction to execute.

The unexecuted paste-service contracts send each string through mocked Mac, Windows, X11, KDE Wayland and missing-injector routes. They compare clipboard bytes and fixed paste actions; KDE receives the whole string as one clipboard argument. No normalization, trimming, per-character typing or command execution is expected.

These contracts do not prove what a native destination application accepts. Later authorized manual validation should paste each fixture into a disposable plain-text editor and browser field on the owner's supported desktops, copy it back, and compare UTF-8 bytes with the reference. Record platform, application/version, paste method, exact fixture ID and differences; include RTL appearance separately from stored string equality. A destination may intentionally convert CRLF or normalize Unicode, which must be attributed to that application. Avoid password fields, terminals and real conversations for this fixture exercise; literal command text is covered by mocks and a plain-text editor only.

UNVERIFIED — tests, builds, typechecks, formatting checks, browser/Electron smoke and native clipboard/destination checks were skipped per user instruction. No personal clipboard content or transcript was used. Issue #123 remains open pending native validation.
