# Renderer startup failure evidence

These tests use the real React workspace with desktop-shaped mocked IPC and a virtual browser clock. They verify renderer behavior rather than native inference, platform authorization, or actual service availability. All settings/history are browser fixture data; personal profiles and runtimes are untouched.

| Journey                                                      | Regression evidence                                                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Optional updater rejects                                     | reliability.pw.ts and startup-failures.pw.ts preserve Controls                                                                |
| Speech, rewriting, shortcut, capabilities or updater rejects | startup-failures.pw.ts verifies existing history, settings, navigation and degraded controls for each individual read         |
| Essential settings/history never settles                     | startup.pw.ts advances to the named deadline, retries successfully and resolves the abandoned reply afterward                 |
| Optional reads never settle                                  | startup.pw.ts checks bounded degraded startup with multiple hung optional services                                            |
| Essential history is slow but succeeds                       | startup-failures.pw.ts completes a four-second read before the deadline and retains actual history                            |
| A status event arrives during startup                        | startup.pw.ts preserves the current listening event over timeout/late snapshot                                                |
| A status event arrives after a failed initial read           | startup-failures.pw.ts restores speech and rewriting through live subscriptions                                               |
| Several startup retries fail before one succeeds             | startup-failures.pw.ts checks old removers ran, exactly one listener remains per event, and live events still update Controls |
| Workspace disposal and late backend rejection                | startupServices.test.ts verifies timer disposal, cancelled queued reads and observed late rejection                           |

The subscription fixture exposes registrations/removals only for inspection; production useWorkspace performs the actual subscription cleanup. Slow-service tests move the virtual clock instead of adding wall-clock waits. No new product API is required for these checks. REC-01 provides the startup deadlines and isolation under test; renderer process crashes, native service hangs and real desktop lifecycle testing remain separate evidence categories.
