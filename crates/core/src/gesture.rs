//! Hold-or-tap rules for the dictation hotkey.
//!
//! A tap starts recording and the next press stops it. Holding the key for at
//! least [`HOLD_MS`] records while held and stops on release.

pub const HOLD_MS: u64 = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    Pressed,
    Released,
    /// A shortcut backend that only reports activations (no press/release).
    Activated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Start,
    Stop,
}

#[derive(Debug, Default)]
pub struct Gesture {
    down: bool,
    started: Option<u64>,
    recording: bool,
    ignore_release: bool,
}

impl Gesture {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn keys_down(&self) -> bool {
        self.down
    }
    /// Follows the physical key while the app is busy, without producing
    /// commands, so `keys_down` stays truthful and the release of a press made
    /// while busy never stops a later recording.
    pub fn track(&mut self, event: KeyEvent) {
        match event {
            KeyEvent::Pressed => {
                self.down = true;
                self.ignore_release = true;
            }
            KeyEvent::Released => {
                self.down = false;
                self.ignore_release = false;
                self.started = None;
            }
            KeyEvent::Activated => {}
        }
    }
    pub fn feed(&mut self, event: KeyEvent, now_ms: u64) -> Option<Command> {
        match event {
            KeyEvent::Activated => {
                self.recording = !self.recording;
                self.started = None;
                Some(if self.recording {
                    Command::Start
                } else {
                    Command::Stop
                })
            }
            KeyEvent::Pressed if !self.down => {
                self.down = true;
                if self.recording {
                    self.recording = false;
                    self.ignore_release = true;
                    self.started = None;
                    Some(Command::Stop)
                } else {
                    self.recording = true;
                    self.started = Some(now_ms);
                    Some(Command::Start)
                }
            }
            KeyEvent::Released if self.down => {
                self.down = false;
                if self.ignore_release {
                    self.ignore_release = false;
                    None
                } else if self
                    .started
                    .take()
                    .is_some_and(|start| now_ms.saturating_sub(start) >= HOLD_MS)
                {
                    self.recording = false;
                    Some(Command::Stop)
                } else {
                    None
                }
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gesture_paths() {
        let mut g = Gesture::new();
        assert_eq!(g.feed(KeyEvent::Released, 0), None);
        assert_eq!(g.feed(KeyEvent::Pressed, 0), Some(Command::Start));
        assert!(g.keys_down());
        assert_eq!(g.feed(KeyEvent::Pressed, 1), None);
        assert_eq!(g.feed(KeyEvent::Released, 400), Some(Command::Stop));
        assert!(!g.keys_down());
        assert_eq!(g.feed(KeyEvent::Pressed, 500), Some(Command::Start));
        assert_eq!(g.feed(KeyEvent::Released, 501), None);
        assert_eq!(g.feed(KeyEvent::Pressed, 502), Some(Command::Stop));
        assert!(g.keys_down());
        assert_eq!(g.feed(KeyEvent::Released, 503), None);
        assert_eq!(g.feed(KeyEvent::Activated, 504), Some(Command::Start));
        assert_eq!(g.feed(KeyEvent::Activated, 505), Some(Command::Stop));
        assert!(!g.keys_down());
    }
    #[test]
    fn busy_presses_are_tracked_but_ignored() {
        let mut g = Gesture::new();
        g.track(KeyEvent::Pressed);
        assert!(g.keys_down());
        // Released after the app became idle again: no command, key is up.
        assert_eq!(g.feed(KeyEvent::Released, 10), None);
        assert!(!g.keys_down());
        g.track(KeyEvent::Pressed);
        g.track(KeyEvent::Released);
        assert!(!g.keys_down());
        assert_eq!(g.feed(KeyEvent::Pressed, 20), Some(Command::Start));
    }
}
