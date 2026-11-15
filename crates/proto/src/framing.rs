//! Newline framing shared by the daemon and its clients.
//!
//! One JSON value per line, UTF-8, terminated by `\n` (a preceding `\r` is
//! dropped). Blank lines are skipped. A line longer than the limit is reported
//! once as [`Frame::TooLong`] and discarded up to its newline, so one bad line
//! never costs more than the limit in memory and never ends the connection.

/// Requests and events are small; the largest is a history page or the state
/// snapshot. 4 MiB leaves room while stopping a runaway peer.
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Line(String),
    /// A line exceeded the limit; it was dropped.
    TooLong,
    /// A line was not valid UTF-8; it was dropped.
    NotUtf8,
}

#[derive(Debug)]
pub struct LineDecoder {
    buf: Vec<u8>,
    max: usize,
    /// Dropping the rest of an overlong line until its newline.
    discarding: bool,
}

impl Default for LineDecoder {
    fn default() -> Self {
        Self::new(MAX_LINE_BYTES)
    }
}

impl LineDecoder {
    pub fn new(max: usize) -> Self {
        Self {
            buf: Vec::new(),
            max,
            discarding: false,
        }
    }

    /// Feeds bytes read from the stream and returns every frame they complete.
    pub fn push(&mut self, mut bytes: &[u8]) -> Vec<Frame> {
        let mut frames = Vec::new();
        while !bytes.is_empty() {
            let newline = bytes.iter().position(|&b| b == b'\n');
            let (chunk, rest, complete) = match newline {
                Some(i) => (&bytes[..i], &bytes[i + 1..], true),
                None => (bytes, &[][..], false),
            };
            bytes = rest;
            if self.discarding {
                if complete {
                    self.discarding = false;
                }
                continue;
            }
            if self.buf.len() + chunk.len() > self.max {
                self.buf.clear();
                frames.push(Frame::TooLong);
                self.discarding = !complete;
                continue;
            }
            self.buf.extend_from_slice(chunk);
            if complete {
                let mut line = std::mem::take(&mut self.buf);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                frames.push(match String::from_utf8(line) {
                    Ok(line) => Frame::Line(line),
                    Err(_) => Frame::NotUtf8,
                });
            }
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_split_across_reads_are_joined() {
        let mut d = LineDecoder::new(64);
        assert!(d.push(b"{\"a\":").is_empty());
        assert_eq!(
            d.push(b"1}\r\n\n{\"b\":2}\n{\"c\""),
            [
                Frame::Line("{\"a\":1}".into()),
                Frame::Line("{\"b\":2}".into())
            ]
        );
        assert_eq!(d.push(b":3}\n"), [Frame::Line("{\"c\":3}".into())]);
    }

    #[test]
    fn an_overlong_line_is_dropped_once_and_the_next_line_survives() {
        let mut d = LineDecoder::new(8);
        assert_eq!(d.push(b"0123456789"), [Frame::TooLong]);
        // The rest of the long line, still arriving, is discarded silently.
        assert!(d.push(b"abcdef").is_empty());
        assert_eq!(d.push(b"gh\nok\n"), [Frame::Line("ok".into())]);
        // A long line that ends in the same read.
        assert_eq!(
            d.push(b"0123456789\nfine\n"),
            [Frame::TooLong, Frame::Line("fine".into())]
        );
    }

    #[test]
    fn invalid_utf8_is_reported_and_skipped() {
        let mut d = LineDecoder::new(64);
        assert_eq!(
            d.push(b"\xff\xfe\nnext\n"),
            [Frame::NotUtf8, Frame::Line("next".into())]
        );
    }
}
