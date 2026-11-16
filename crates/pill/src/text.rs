//! The result word and the "!" mark: one embedded bold face (an Inter Bold
//! subset, 17.5 KB, OFL; see `fonts/OFL.txt`), outlines through ttf-parser,
//! filled by tiny-skia like every other shape. Embedding gives the same look on
//! every distro and needs no fontconfig.
//!
//! Layout is deliberately simple: one glyph per char from the cmap, no kerning
//! and no shaping, which suits a single short word. Chars the subset lacks
//! (outside Latin-1) draw as the font's missing-glyph box.

use tiny_skia::{Path, PathBuilder};
use ttf_parser::{Face, GlyphId, OutlineBuilder};

static INTER_BOLD: &[u8] = include_bytes!("../fonts/Inter-Bold-subset.ttf");

pub struct Font {
    face: Face<'static>,
}

/// Ink extents in the cairo sense: bearing from the pen, size, and advance.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Extents {
    pub x_bearing: f32,
    pub y_bearing: f32,
    pub width: f32,
    pub height: f32,
    pub x_advance: f32,
}

impl Font {
    pub fn embedded() -> Font {
        Font {
            face: Face::parse(INTER_BOLD, 0).expect("the embedded font parses"),
        }
    }

    fn layout(&self, text: &str, size: f32) -> (Vec<(GlyphId, f32)>, f32) {
        let k = size / f32::from(self.face.units_per_em());
        let mut pen = 0.0;
        let mut glyphs = Vec::with_capacity(text.len());
        for ch in text.chars() {
            let id = self.face.glyph_index(ch).unwrap_or(GlyphId(0));
            glyphs.push((id, pen));
            pen += f32::from(self.face.glyph_hor_advance(id).unwrap_or(0)) * k;
        }
        (glyphs, pen)
    }

    pub fn extents(&self, text: &str, size: f32) -> Extents {
        let k = size / f32::from(self.face.units_per_em());
        let (glyphs, advance) = self.layout(text, size);
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for (id, pen) in glyphs {
            if let Some(b) = self.face.glyph_bounding_box(id) {
                x0 = x0.min(pen + f32::from(b.x_min) * k);
                x1 = x1.max(pen + f32::from(b.x_max) * k);
                // Font units point up; the canvas y points down.
                y0 = y0.min(-f32::from(b.y_max) * k);
                y1 = y1.max(-f32::from(b.y_min) * k);
            }
        }
        if x0 > x1 {
            return Extents {
                x_advance: advance,
                ..Extents::default()
            };
        }
        Extents {
            x_bearing: x0,
            y_bearing: y0,
            width: x1 - x0,
            height: y1 - y0,
            x_advance: advance,
        }
    }

    /// The text's outline with its baseline origin at (x, y).
    pub fn path(&self, text: &str, size: f32, x: f32, y: f32) -> Option<Path> {
        let k = size / f32::from(self.face.units_per_em());
        let (glyphs, _) = self.layout(text, size);
        let mut out = Outline {
            pb: PathBuilder::new(),
            k,
            x,
            y,
        };
        for (id, pen) in glyphs {
            out.x = x + pen;
            self.face.outline_glyph(id, &mut out);
        }
        out.pb.finish()
    }
}

struct Outline {
    pb: PathBuilder,
    k: f32,
    x: f32,
    y: f32,
}

impl Outline {
    fn p(&self, x: f32, y: f32) -> (f32, f32) {
        (self.x + x * self.k, self.y - y * self.k)
    }
}

impl OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.p(x, y);
        self.pb.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.p(x, y);
        self.pb.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (x1, y1) = self.p(x1, y1);
        let (x, y) = self.p(x, y);
        self.pb.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (x1, y1) = self.p(x1, y1);
        let (x2, y2) = self.p(x2, y2);
        let (x, y) = self.p(x, y);
        self.pb.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.pb.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_the_words_the_app_shows() {
        let font = Font::embedded();
        // Every pill word the daemon and app send, plus accents and typography.
        for word in ["Typed", "Copied", "Nothing heard", "No microphone", "Mic error", "Not typed", "Not transcribed", "Über", "é…€"] {
            for ch in word.chars() {
                assert!(font.face.glyph_index(ch).is_some(), "{ch:?} missing from the subset");
            }
        }
        let e = font.extents("Typed", 12.5);
        assert!(e.width > 30.0 && e.width < 45.0, "{e:?}");
        assert!(e.y_bearing < -8.0 && e.height > 9.0, "{e:?}");
    }
}
