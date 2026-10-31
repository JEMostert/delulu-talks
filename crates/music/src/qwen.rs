//! YuE2's two Qwen3-style transformers on ggml: the language model that plans the
//! score and the music tokens, and the acoustic transformer that turns noise into
//! VAE latents while attending to the language model's keys and values.
use crate::checkpoint::{hadamard, Checkpoint};
use crate::ggml::{self, Device, Graph, Layout, Store, T};

pub const HIDDEN: i64 = 2048;
pub const LAYERS: usize = 28;
pub const HEADS: i64 = 16;
pub const KV_HEADS: i64 = 8;
pub const HEAD_DIM: i64 = 128;
const KV_WIDTH: i64 = KV_HEADS * HEAD_DIM;
const EPS: f32 = 1e-6;
const ROPE_BASE: f32 = 1_000_000.0;
const ROTATION: i64 = 256;
pub const LATENT: i64 = 64;
pub const POSITIONS: i64 = 24576;

/// An INT8 ConvRot linear layer: `y = scale * (W_rot · (H x)) + bias`.
struct Lin {
    w: T,
    scale: T,
    bias: Option<T>,
}

struct Layer {
    ln1: T,
    ln2: T,
    q_norm: T,
    k_norm: T,
    qkv: Lin,
    o: Lin,
    gate_up: Lin,
    down: Lin,
}

/// Tensors to fill once the store has memory.
enum Fill {
    Lin(String, T, T, Option<T>),
    F32(String, T),
    Data(Vec<f32>, T),
}

struct Loader<'a> {
    ck: &'a Checkpoint,
    layout: Layout,
    fills: Vec<Fill>,
}

impl<'a> Loader<'a> {
    fn new(ck: &'a Checkpoint, tensors: usize) -> Self {
        Loader {
            ck,
            layout: Layout::new(tensors),
            fills: Vec::new(),
        }
    }
    fn lin(&mut self, prefix: &str) -> Result<Lin, String> {
        let shape = self.ck.shape(&format!("{prefix}.weight"))?;
        let (rows, cols) = (shape[0] as i64, shape[1] as i64);
        let w = self.layout.tensor(ggml::Q8_0, &[cols, rows]);
        let scale = self.layout.tensor(ggml::F32, &[rows]);
        let bias = self
            .ck
            .entries
            .contains_key(&format!("{prefix}.bias"))
            .then(|| self.layout.tensor(ggml::F32, &[rows]));
        self.fills.push(Fill::Lin(prefix.into(), w, scale, bias));
        Ok(Lin { w, scale, bias })
    }
    fn f32(&mut self, name: &str) -> Result<T, String> {
        let shape: Vec<i64> = self
            .ck
            .shape(name)?
            .iter()
            .rev()
            .map(|&v| v as i64)
            .collect();
        let t = self.layout.tensor(ggml::F32, &shape);
        self.fills.push(Fill::F32(name.into(), t));
        Ok(t)
    }
    fn data(&mut self, data: Vec<f32>, ne: &[i64]) -> T {
        let t = self.layout.tensor(ggml::F32, ne);
        self.fills.push(Fill::Data(data, t));
        t
    }
    fn layer(&mut self, prefix: &str) -> Result<Layer, String> {
        Ok(Layer {
            ln1: self.f32(&format!("{prefix}.input_layernorm.weight"))?,
            ln2: self.f32(&format!("{prefix}.post_attention_layernorm.weight"))?,
            q_norm: self.f32(&format!("{prefix}.self_attn.q_norm.weight"))?,
            k_norm: self.f32(&format!("{prefix}.self_attn.k_norm.weight"))?,
            qkv: self.lin(&format!("{prefix}.self_attn.qkv_proj"))?,
            o: self.lin(&format!("{prefix}.self_attn.o_proj"))?,
            gate_up: self.lin(&format!("{prefix}.mlp.gate_up_proj"))?,
            down: self.lin(&format!("{prefix}.mlp.down_proj"))?,
        })
    }
    /// Allocate on the device and upload, checking every linear is rotated as expected.
    fn finish(self, device: &Device, cancel: &dyn Fn() -> bool) -> Result<Store, String> {
        let store = self.layout.allocate(device)?;
        for fill in self.fills {
            if cancel() {
                return Err(crate::CANCELLED.into());
            }
            match fill {
                Fill::Lin(prefix, w, scale, bias) => {
                    let l = self.ck.int8_linear(&prefix)?;
                    if l.group != ROTATION as usize {
                        return Err(format!("{prefix}: unexpected rotation group {}", l.group));
                    }
                    w.set_bytes(0, &l.q8);
                    scale.set(&l.scale);
                    if let (Some(t), Some(b)) = (bias, l.bias) {
                        t.set(&b);
                    }
                }
                Fill::F32(name, t) => t.set(&self.ck.f32(&name)?),
                Fill::Data(data, t) => t.set(&data),
            }
        }
        Ok(store)
    }
}

/// The shared stack of transformer blocks.
struct Blocks {
    layers: Vec<Layer>,
    norm: T,
    hadamard: T,
}

impl Blocks {
    fn load(l: &mut Loader, prefix: &str) -> Result<Blocks, String> {
        let layers = (0..LAYERS)
            .map(|i| l.layer(&format!("{prefix}.layers.{i}")))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Blocks {
            layers,
            norm: l.f32(&format!("{prefix}.norm.weight"))?,
            hadamard: l.data(hadamard(ROTATION as usize), &[ROTATION, ROTATION]),
        })
    }

    /// Rotate `[K, N]` activations in groups of 256 (the Hadamard matrix is symmetric).
    fn rotate(&self, g: &Graph, x: T) -> T {
        let (k, n) = (x.ne(0), x.ne(1));
        let grouped = g.reshape(x, &[ROTATION, k / ROTATION * n]);
        g.reshape(g.mul_mat(self.hadamard, grouped), &[k, n])
    }

    fn lin(&self, g: &Graph, l: &Lin, x: T) -> T {
        let mut y = g.mul(g.mul_mat(l.w, self.rotate(g, x)), l.scale);
        if let Some(b) = l.bias {
            y = g.add(y, b);
        }
        y
    }

    /// All blocks over `x` `[HIDDEN, n]` at positions `pos`, writing each layer's keys
    /// and values into `cache` after `past` cached tokens and attending to all of them.
    /// `mask` is causal for the language model and absent for the acoustic model.
    fn forward(&self, g: &Graph, x: T, pos: T, cache: &Cache, past: i64, mask: Option<T>) -> T {
        let n = x.ne(1);
        let total = past + n;
        let mut x = x;
        for (i, l) in self.layers.iter().enumerate() {
            let h = g.mul(g.rms_norm(x, EPS), l.ln1);
            let qkv = self.lin(g, &l.qkv, h);
            let row = qkv.nb(1);
            let f = 4usize;
            let q = g.view(qkv, &[HEAD_DIM, HEADS, n], &[HEAD_DIM as usize * f, row], 0);
            let k = g.view(
                qkv,
                &[HEAD_DIM, KV_HEADS, n],
                &[HEAD_DIM as usize * f, row],
                (HEADS * HEAD_DIM) as usize * f,
            );
            let v = g.view(
                qkv,
                &[HEAD_DIM, KV_HEADS, n],
                &[HEAD_DIM as usize * f, row],
                ((HEADS + KV_HEADS) * HEAD_DIM) as usize * f,
            );
            let q = g.mul(g.rms_norm(g.cont(q), EPS), l.q_norm);
            let k = g.mul(g.rms_norm(g.cont(k), EPS), l.k_norm);
            let q = g.rope_neox(q, pos, HEAD_DIM as i32, ROPE_BASE);
            let k = g.rope_neox(k, pos, HEAD_DIM as i32, ROPE_BASE);
            // Write this step's keys and values after the cached ones.
            let (kc, vc) = (cache.k[i], cache.v[i]);
            let e = 2usize;
            let at = |c: T| {
                g.view(
                    c,
                    &[HEAD_DIM, KV_HEADS, n],
                    &[HEAD_DIM as usize * e, KV_WIDTH as usize * e],
                    past as usize * KV_WIDTH as usize * e,
                )
            };
            g.expand(g.cpy(k, at(kc)));
            g.expand(g.cpy(v, at(vc)));
            let all = |c: T| {
                g.permute(
                    g.view(
                        c,
                        &[HEAD_DIM, KV_HEADS, total],
                        &[HEAD_DIM as usize * e, KV_WIDTH as usize * e],
                        0,
                    ),
                    [0, 2, 1, 3],
                )
            };
            let q = g.permute(q, [0, 2, 1, 3]);
            let scale = 1.0 / (HEAD_DIM as f32).sqrt();
            let attn = g.attention(q, all(kc), all(vc), mask, scale);
            let attn = g.reshape(attn, &[HEADS * HEAD_DIM, n]);
            x = g.add(x, self.lin(g, &l.o, attn));
            let h = g.mul(g.rms_norm(x, EPS), l.ln2);
            let up = self.lin(g, &l.gate_up, h);
            x = g.add(x, self.lin(g, &l.down, g.swiglu(up)));
        }
        g.mul(g.rms_norm(x, EPS), self.norm)
    }
}

/// Keys and values for every layer, F16 `[KV_WIDTH, capacity]`.
pub struct Cache {
    k: Vec<T>,
    v: Vec<T>,
    pub capacity: i64,
    _store: Store,
}

impl Cache {
    pub fn new(device: &Device, capacity: i64) -> Result<Cache, String> {
        let layout = Layout::new(LAYERS * 2);
        let k: Vec<T> = (0..LAYERS)
            .map(|_| layout.tensor(ggml::F16, &[KV_WIDTH, capacity]))
            .collect();
        let v: Vec<T> = (0..LAYERS)
            .map(|_| layout.tensor(ggml::F16, &[KV_WIDTH, capacity]))
            .collect();
        let store = layout.allocate(device)?;
        Ok(Cache {
            k,
            v,
            capacity,
            _store: store,
        })
    }
}

/// A causal mask for `n` new tokens after `past` cached ones: `[past + n, n]` F16.
fn causal_mask(past: i64, n: i64) -> Vec<u16> {
    let total = past + n;
    let blocked = ggml::f16_bits(f32::NEG_INFINITY);
    let mut mask = vec![0u16; (total * n) as usize];
    for i in 0..n {
        for j in (past + i + 1)..total {
            mask[(i * total + j) as usize] = blocked;
        }
    }
    mask
}

/// The language model: text and music tokens in, next-token logits out.
pub struct Lm {
    blocks: Blocks,
    embed: Lin,
    embed_scale: T,
    lm_head: Lin,
    pub vocab: i64,
    store: Store,
}

impl Lm {
    pub fn load(ck: &Checkpoint, device: &Device, cancel: &dyn Fn() -> bool) -> Result<Lm, String> {
        let prefix = "text_encoders.model";
        let mut l = Loader::new(ck, LAYERS * 16 + 16);
        let blocks = Blocks::load(&mut l, prefix)?;
        let embed = l.lin(&format!("{prefix}.embed_tokens"))?;
        let vocab = ck.shape(&format!("{prefix}.embed_tokens.weight"))?[0] as i64;
        // Looked up per token: a [1, vocab] table of the rows' scales.
        let embed_scale = l.f32(&format!("{prefix}.embed_tokens.weight_scale"))?;
        let lm_head = l.lin(&format!("{prefix}.lm_head"))?;
        let store = l.finish(device, cancel)?;
        Ok(Lm {
            blocks,
            embed,
            embed_scale,
            lm_head,
            vocab,
            store,
        })
    }

    pub fn bytes(&self) -> usize {
        self.store.bytes()
    }

    /// Embed token ids: dequantize the INT8 rows, scale, and rotate back.
    fn embed(&self, g: &Graph, ids: T) -> T {
        let rows = g.get_rows(self.embed.w, ids);
        let scales = g.get_rows(self.embed_scale, ids);
        self.blocks.rotate(g, g.mul(rows, scales))
    }

    fn inputs(&self, g: &Graph, n: i64, past: i64) -> (T, T, Option<T>) {
        let ids = g.input(ggml::I32, &[n]);
        let pos = g.input(ggml::I32, &[n]);
        let mask = (n > 1).then(|| g.input(ggml::F16, &[past + n, n]));
        (ids, pos, mask)
    }

    fn upload(ids: &[u32], past: i64, t: (T, T, Option<T>)) {
        let n = ids.len() as i64;
        let tokens: Vec<i32> = ids.iter().map(|&v| v as i32).collect();
        t.0.set(&tokens);
        let pos: Vec<i32> = (past..past + n).map(|p| p as i32).collect();
        t.1.set(&pos);
        if let Some(mask) = t.2 {
            mask.set(&causal_mask(past, n));
        }
    }

    /// Feed `ids` after `past` cached tokens; logits for the last one.
    pub fn step(
        &self,
        device: &Device,
        cache: &Cache,
        ids: &[u32],
        past: i64,
    ) -> Result<Vec<f32>, String> {
        let n = ids.len() as i64;
        if past + n > cache.capacity {
            return Err("the music model ran out of context".into());
        }
        let g = Graph::new();
        let inputs = self.inputs(&g, n, past);
        let x = self.embed(&g, inputs.0);
        let x = self.blocks.forward(&g, x, inputs.1, cache, past, inputs.2);
        let last = g.view(x, &[HIDDEN, 1], &[x.nb(1)], (n - 1) as usize * x.nb(1));
        let logits = g.output(self.blocks.lin(&g, &self.lm_head, last));
        device.compute(&g, || Self::upload(ids, past, inputs))?;
        Ok(logits.get_f32())
    }

    /// Fill `cache` with the keys and values of `ids` from position 0 (the acoustic
    /// model's conditioning). Processed in slices to bound memory.
    pub fn prefill(&self, device: &Device, cache: &Cache, ids: &[u32]) -> Result<(), String> {
        const SLICE: usize = 2048;
        let mut past = 0i64;
        for part in ids.chunks(SLICE) {
            let n = part.len() as i64;
            let g = Graph::new();
            let inputs = self.inputs(&g, n, past);
            let x = self.embed(&g, inputs.0);
            let x = self.blocks.forward(&g, x, inputs.1, cache, past, inputs.2);
            // The final norm output keeps every cache write in the graph.
            g.output(x);
            device.compute(&g, || Self::upload(part, past, inputs))?;
            past += n;
        }
        Ok(())
    }
}

/// The acoustic transformer: predicts the flow velocity of VAE latents.
pub struct Dit {
    blocks: Blocks,
    vae2llm: (T, T),
    llm2vae: Lin,
    time1: Lin,
    time2: Lin,
    positions: T,
    store: Store,
}

impl Dit {
    pub fn load(
        ck: &Checkpoint,
        device: &Device,
        cancel: &dyn Fn() -> bool,
    ) -> Result<Dit, String> {
        let prefix = "model.diffusion_model";
        let mut l = Loader::new(ck, LAYERS * 16 + 16);
        let blocks = Blocks::load(&mut l, &format!("{prefix}.model"))?;
        let vae2llm = (
            l.f32(&format!("{prefix}.vae2llm.weight"))?,
            l.f32(&format!("{prefix}.vae2llm.bias"))?,
        );
        let llm2vae = l.lin(&format!("{prefix}.llm2vae"))?;
        let time1 = l.lin(&format!("{prefix}.time_embedder.mlp.0"))?;
        let time2 = l.lin(&format!("{prefix}.time_embedder.mlp.2"))?;
        let positions = l.f32(&format!("{prefix}.latent_pos_embed.pe"))?;
        let store = l.finish(device, cancel)?;
        Ok(Dit {
            blocks,
            vae2llm,
            llm2vae,
            time1,
            time2,
            positions,
            store,
        })
    }

    pub fn bytes(&self) -> usize {
        self.store.bytes()
    }

    /// The most frames one pass can take after a conditioning prefix of `prefix` tokens.
    pub fn max_frames(prefix: i64) -> i64 {
        (POSITIONS - prefix - 3) / 2
    }

    /// Velocity for latents `x` (`[frames][64]`, row-major) at flow time `t`.
    /// `cond` holds the language model's keys and values for `prefix` tokens and has
    /// room for `frames + 2` more.
    pub fn velocity(
        &self,
        device: &Device,
        cond: &Cache,
        prefix: i64,
        x: &[f32],
        t: f32,
    ) -> Result<Vec<f32>, String> {
        let frames = x.len() as i64 / LATENT;
        let n = frames + 2;
        if prefix + n > cond.capacity || n > POSITIONS {
            return Err("the song is too long for one acoustic pass".into());
        }
        let g = Graph::new();
        let input = g.input(ggml::F32, &[LATENT, n]);
        let time = g.input(ggml::F32, &[1]);
        let pos = g.input(ggml::I32, &[n]);
        let h = g.add(g.mul_mat(self.vae2llm.0, input), self.vae2llm.1);
        let emb = g.timestep_embedding(time, 256);
        let emb = self.blocks.lin(&g, &self.time1, emb);
        let emb = self.blocks.lin(&g, &self.time2, g.silu(emb));
        let pe = g.view(self.positions, &[HIDDEN, n], &[self.positions.nb(1)], 0);
        let h = g.add(g.add(h, emb), pe);
        let h = self.blocks.forward(&g, h, pos, cond, prefix, None);
        let out = g.output(self.blocks.lin(&g, &self.llm2vae, h));
        device.compute(&g, || {
            let mut padded = vec![0f32; (n * LATENT) as usize];
            padded[LATENT as usize..(LATENT * (frames + 1)) as usize].copy_from_slice(x);
            input.set(&padded);
            time.set(&[t]);
            let p: Vec<i32> = (prefix..prefix + n).map(|v| v as i32).collect();
            pos.set(&p);
        })?;
        let all = out.get_f32();
        Ok(all[LATENT as usize..(LATENT * (frames + 1)) as usize].to_vec())
    }
}
