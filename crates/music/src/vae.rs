//! YuE2's audio VAE decoder (an Oobleck decoder with Snake activations): 64-channel
//! latents at 25 frames per second to 48 kHz stereo. Decoded in overlapping tiles so
//! memory stays bounded for long songs; the overlap covers the receptive field.
use crate::checkpoint::Checkpoint;
use crate::ggml::{self, f16_bits, Device, Graph, Layout, Store, T};
use crate::qwen::LATENT;

pub const SAMPLE_RATE: u32 = 48_000;
pub const HOP: usize = 1920;
const TILE: usize = 128;
const OVERLAP: usize = 32;
/// Decoder channel widths from the latent side down, and each block's upsampling.
const WIDTHS: [i64; 7] = [2048, 1024, 512, 256, 128, 64, 64];
const STRIDES: [i32; 6] = [6, 5, 4, 4, 2, 2];

struct Snake {
    /// exp(alpha) and 1 / (exp(beta) + 1e-9), `[1, C]`.
    alpha: T,
    inv_beta: T,
}

struct Conv {
    /// `[K, IC, OC]` F16.
    w: T,
    bias: Option<T>,
    dilation: i32,
    pad: i32,
}

struct Unit {
    snake1: Snake,
    conv1: Conv,
    snake2: Snake,
    conv2: Conv,
}

struct Block {
    snake: Snake,
    /// Transposed convolution as `[IC, OC*K]` F16 GEMM columns.
    up: T,
    up_bias: T,
    channels: i64,
    stride: i32,
    pad: i64,
    units: [Unit; 3],
}

pub struct Vae {
    input: Conv,
    blocks: Vec<Block>,
    snake: Snake,
    output: Conv,
    _store: Store,
}

/// `g * v / ||v||` with the norm over every dim but the first.
fn weight_norm(ck: &Checkpoint, prefix: &str) -> Result<(Vec<f32>, Vec<usize>), String> {
    let g = ck.f32(&format!("{prefix}.weight_g"))?;
    let v = ck.f32(&format!("{prefix}.weight_v"))?;
    let shape = ck.shape(&format!("{prefix}.weight_v"))?;
    let per = v.len() / shape[0];
    let mut out = v.clone();
    for (i, row) in out.chunks_mut(per).enumerate() {
        let norm = row.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
        let s = g[i] / norm;
        row.iter_mut().for_each(|x| *x *= s);
    }
    Ok((out, shape))
}

fn half(data: &[f32]) -> Vec<u16> {
    data.iter().map(|&v| f16_bits(v)).collect()
}

struct Loader<'a> {
    ck: &'a Checkpoint,
    layout: Layout,
    fills: Vec<(T, Fill)>,
}

enum Fill {
    F32(Vec<f32>),
    F16(Vec<u16>),
}

impl Loader<'_> {
    fn f32(&mut self, data: Vec<f32>, ne: &[i64]) -> T {
        let t = self.layout.tensor(ggml::F32, ne);
        self.fills.push((t, Fill::F32(data)));
        t
    }
    fn snake(&mut self, prefix: &str) -> Result<Snake, String> {
        let alpha: Vec<f32> = self
            .ck
            .f32(&format!("{prefix}.alpha"))?
            .iter()
            .map(|a| a.exp())
            .collect();
        let beta: Vec<f32> = self
            .ck
            .f32(&format!("{prefix}.beta"))?
            .iter()
            .map(|b| 1.0 / (b.exp() + 1e-9))
            .collect();
        let c = alpha.len() as i64;
        Ok(Snake {
            alpha: self.f32(alpha, &[1, c]),
            inv_beta: self.f32(beta, &[1, c]),
        })
    }
    fn conv(&mut self, prefix: &str, dilation: i32, bias: bool) -> Result<Conv, String> {
        let (w, shape) = weight_norm(self.ck, prefix)?;
        let (oc, ic, k) = (shape[0] as i64, shape[1] as i64, shape[2] as i64);
        let t = self.layout.tensor(ggml::F16, &[k, ic, oc]);
        self.fills.push((t, Fill::F16(half(&w))));
        let bias = if bias {
            let b = self.ck.f32(&format!("{prefix}.bias"))?;
            Some(self.f32(b, &[1, oc]))
        } else {
            None
        };
        Ok(Conv {
            w: t,
            bias,
            dilation,
            pad: (dilation * (k as i32 - 1)) / 2,
        })
    }
    fn unit(&mut self, prefix: &str, dilation: i32) -> Result<Unit, String> {
        Ok(Unit {
            snake1: self.snake(&format!("{prefix}.layers.0"))?,
            conv1: self.conv(&format!("{prefix}.layers.1"), dilation, true)?,
            snake2: self.snake(&format!("{prefix}.layers.2"))?,
            conv2: self.conv(&format!("{prefix}.layers.3"), 1, true)?,
        })
    }
}

impl Vae {
    pub fn load(ck: &Checkpoint, device: &Device) -> Result<Vae, String> {
        let mut l = Loader {
            ck,
            layout: Layout::new(512),
            fills: Vec::new(),
        };
        let p = "vae.decoder.layers";
        let input = l.conv(&format!("{p}.0"), 1, true)?;
        let mut blocks = Vec::new();
        for (i, &stride) in STRIDES.iter().enumerate() {
            let b = format!("{p}.{}", i + 1);
            let snake = l.snake(&format!("{b}.layers.0"))?;
            let (w, shape) = weight_norm(ck, &format!("{b}.layers.1"))?;
            let (ic, oc, k) = (shape[0], shape[1], shape[2]);
            if ic as i64 != WIDTHS[i] || oc as i64 != WIDTHS[i + 1] || k != 2 * stride as usize {
                return Err(format!("unexpected VAE block {i} shape {shape:?}"));
            }
            // [IC][OC][K] -> columns [IC, OC*K] with IC fastest.
            let mut cols = vec![0f32; w.len()];
            for c in 0..ic {
                for j in 0..oc * k {
                    cols[j * ic + c] = w[c * oc * k + j];
                }
            }
            let up = l.layout.tensor(ggml::F16, &[ic as i64, (oc * k) as i64]);
            l.fills.push((up, Fill::F16(half(&cols))));
            let bias = ck.f32(&format!("{b}.layers.1.bias"))?;
            let up_bias = l.f32(bias, &[1, oc as i64]);
            let units = [
                l.unit(&format!("{b}.layers.2"), 1)?,
                l.unit(&format!("{b}.layers.3"), 3)?,
                l.unit(&format!("{b}.layers.4"), 9)?,
            ];
            blocks.push(Block {
                snake,
                up,
                up_bias,
                channels: oc as i64,
                stride,
                pad: (stride as i64 + 1) / 2,
                units,
            });
        }
        let snake = l.snake(&format!("{p}.7"))?;
        let output = l.conv(&format!("{p}.8"), 1, false)?;
        let store = l.layout.allocate(device)?;
        for (t, fill) in l.fills {
            match fill {
                Fill::F32(d) => t.set(&d),
                Fill::F16(d) => t.set(&d),
            }
        }
        Ok(Vae {
            input,
            blocks,
            snake,
            output,
            _store: store,
        })
    }

    fn snake(g: &Graph, s: &Snake, x: T) -> T {
        let wave = g.sqr(g.sin(g.mul(x, s.alpha)));
        g.add(x, g.mul(wave, s.inv_beta))
    }

    fn conv(g: &Graph, c: &Conv, x: T) -> T {
        let y = g.conv_1d(c.w, x, 1, c.pad, c.dilation);
        let y = g.reshape(y, &[y.ne(0), y.ne(1)]);
        match c.bias {
            Some(b) => g.add(y, b),
            None => y,
        }
    }

    fn block(g: &Graph, b: &Block, x: T) -> T {
        let x = Self::snake(g, &b.snake, x);
        let frames = x.ne(0);
        let cols = g.mul_mat(b.up, g.cont(g.transpose(x)));
        let full = g.col2im_1d(cols, b.stride, b.channels as i32, 0);
        let len = frames * b.stride as i64;
        let y = g.cont(g.view(full, &[len, b.channels], &[full.nb(1)], b.pad as usize * 4));
        let mut y = g.add(y, b.up_bias);
        for u in &b.units {
            let h = Self::conv(g, &u.conv1, Self::snake(g, &u.snake1, y));
            let h = Self::conv(g, &u.conv2, Self::snake(g, &u.snake2, h));
            y = g.add(y, h);
        }
        y
    }

    /// Decode `[frames][64]` latents to interleaved stereo at 48 kHz.
    pub fn decode(
        &self,
        device: &Device,
        latents: &[f32],
        cancel: &dyn Fn() -> bool,
        progress: &mut dyn FnMut(usize, usize),
    ) -> Result<Vec<f32>, String> {
        let c = LATENT as usize;
        let frames = latents.len() / c;
        let mut out = vec![0f32; frames * HOP * 2];
        let tiles = frames.div_ceil(TILE);
        for tile in 0..tiles {
            if cancel() {
                return Err(crate::CANCELLED.into());
            }
            let (core0, core1) = (tile * TILE, ((tile + 1) * TILE).min(frames));
            let (a, b) = (core0.saturating_sub(OVERLAP), (core1 + OVERLAP).min(frames));
            let n = b - a;
            let g = Graph::new();
            let input = g.input(ggml::F32, &[n as i64, LATENT]);
            let mut x = Self::conv(&g, &self.input, input);
            for block in &self.blocks {
                x = Self::block(&g, block, x);
            }
            let x = Self::conv(&g, &self.output, Self::snake(&g, &self.snake, x));
            let audio = g.output(x);
            device.compute(&g, || {
                // Channel-major for ggml's [time, channel] layout.
                let mut data = vec![0f32; n * c];
                for f in 0..n {
                    for ch in 0..c {
                        data[ch * n + f] = latents[(a + f) * c + ch];
                    }
                }
                input.set(&data);
            })?;
            let pcm = audio.get_f32();
            let len = n * HOP;
            let skip = (core0 - a) * HOP;
            for i in 0..(core1 - core0) * HOP {
                let dst = (core0 * HOP + i) * 2;
                out[dst] = pcm[skip + i];
                out[dst + 1] = pcm[len + skip + i];
            }
            progress(tile + 1, tiles);
        }
        Ok(out)
    }
}
