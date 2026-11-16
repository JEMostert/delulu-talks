//! The stdin protocol: one JSON [`Message`] per line. Blank lines are ignored,
//! a bad line is reported and skipped, and a runaway line without a newline is
//! dropped instead of growing without bound.

use crate::Message;
use std::io::{ErrorKind, Read};

/// The longest line kept while waiting for its newline.
const MAX_LINE: usize = 64 * 1024;

/// Splits a (possibly non-blocking) byte stream into messages.
#[derive(Default)]
pub struct Lines {
    pending: Vec<u8>,
}

/// What one [`Lines::read`] found.
#[derive(Debug, Default, PartialEq)]
pub struct Batch {
    pub messages: Vec<Message>,
    /// False once the stream ended or failed: the pill should quit.
    pub open: bool,
}

impl Lines {
    /// Read what `src` has now (until it would block or ends) and parse every
    /// complete line.
    pub fn read(&mut self, src: &mut impl Read) -> Batch {
        let mut buf = [0u8; 4096];
        let open = loop {
            match src.read(&mut buf) {
                Ok(0) => break false,
                Ok(n) => {
                    self.pending.extend_from_slice(&buf[..n]);
                    if n < buf.len() {
                        // A short read: most likely all there is right now. A
                        // blocking source would stall on the next read.
                        break true;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == ErrorKind::WouldBlock => break true,
                Err(e) => {
                    eprintln!("pill: stdin: {e}");
                    break false;
                }
            }
        };
        Batch {
            messages: self.parse(),
            open,
        }
    }

    fn parse(&mut self) -> Vec<Message> {
        let mut messages = Vec::new();
        let mut start = 0;
        while let Some(end) = self.pending[start..].iter().position(|b| *b == b'\n') {
            let line = self.pending[start..start + end].trim_ascii();
            start += end + 1;
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<Message>(line) {
                Ok(m) => messages.push(m),
                Err(e) => eprintln!("pill: bad command: {e}"),
            }
        }
        self.pending.drain(..start);
        if self.pending.len() > MAX_LINE {
            eprintln!("pill: dropped a line longer than {MAX_LINE} bytes");
            self.pending.clear();
        }
        messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PillState;

    /// Hands out its chunks one read at a time, then would block or ends.
    struct Chunks(Vec<Vec<u8>>, bool);

    impl Read for Chunks {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.is_empty() {
                return if self.1 {
                    Ok(0)
                } else {
                    Err(ErrorKind::WouldBlock.into())
                };
            }
            let chunk = self.0.remove(0);
            buf[..chunk.len()].copy_from_slice(&chunk);
            Ok(chunk.len())
        }
    }

    fn chunks(parts: &[&str], ends: bool) -> Chunks {
        Chunks(parts.iter().map(|p| p.as_bytes().to_vec()).collect(), ends)
    }

    #[test]
    fn splits_lines_across_reads_and_skips_bad_ones() {
        let mut lines = Lines::default();
        let first = lines.read(&mut chunks(&[r#"{"state":"listening","le"#], false));
        assert_eq!(
            first,
            Batch {
                messages: vec![],
                open: true
            }
        );
        let rest = lines.read(&mut chunks(
            &["vel\":0.5}\n\n  \nnot json\n{\"state\":\"success\",\"label\":\"Typed\"}\n{\"state\""],
            false,
        ));
        let states: Vec<_> = rest
            .messages
            .iter()
            .map(|m| (m.state, m.level, m.label.clone()))
            .collect();
        assert_eq!(
            states,
            [
                (PillState::Listening, Some(0.5), None),
                (PillState::Success, None, Some("Typed".into()))
            ]
        );
        assert!(rest.open);
        let last = lines.read(&mut chunks(&[":\"hidden\"}\n"], true));
        assert_eq!(last.messages.len(), 1);
        // A short read ends the batch; poll(2) wakes the pill again for the end.
        let end = lines.read(&mut chunks(&[], true));
        assert!(!end.open, "end of input closes the pill");
    }

    #[test]
    fn unknown_fields_from_newer_clients_are_ignored() {
        let mut lines = Lines::default();
        let read = lines.read(&mut chunks(
            &["{\"state\":\"error\",\"label\":\"Nope\",\"output\":\"DP-1\"}\n"],
            true,
        ));
        assert_eq!(read.messages[0].state, PillState::Error);
    }

    #[test]
    fn a_runaway_line_is_dropped_and_parsing_recovers() {
        let mut lines = Lines::default();
        let junk = "x".repeat(4096);
        // Full reads keep going; the short one ends this batch without a newline.
        let mut parts: Vec<&str> = vec![&junk; MAX_LINE / 4096 + 1];
        parts.push("x");
        let first = lines.read(&mut chunks(&parts, false));
        assert!(first.messages.is_empty() && first.open);
        assert!(lines.pending.is_empty(), "the runaway line is not kept");
        let next = lines.read(&mut chunks(&["\n{\"state\":\"transcribing\"}\n"], false));
        assert_eq!(next.messages.len(), 1);
        assert_eq!(next.messages[0].state, PillState::Transcribing);
    }
}
