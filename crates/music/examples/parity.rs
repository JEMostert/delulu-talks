//! Runs single stages of the engine on given inputs, for comparison with ComfyUI's
//! YuE2 implementation. Files are raw little-endian f32 / JSON id lists.
//! `parity lm <model> <ids.json> <logits.f32>`
//! `parity dit <model> <ids.json> <x.f32> <t> <v.f32>`
//! `parity vae <model> <latent.f32> <audio.f32>`
use delulu_music::checkpoint::Checkpoint;
use delulu_music::ggml::Device;
use delulu_music::qwen::{Cache, Dit, Lm};
use std::path::Path;

fn read_f32(p: &str) -> Vec<f32> {
    std::fs::read(p)
        .unwrap()
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
}
fn write_f32(p: &str, v: &[f32]) {
    std::fs::write(
        p,
        v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>(),
    )
    .unwrap();
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let device = Device::new(8).unwrap();
    let ck = Checkpoint::open(Path::new(&a[2])).unwrap();
    let never = || false;
    match a[1].as_str() {
        "lm" => {
            let ids: Vec<u32> = serde_json::from_slice(&std::fs::read(&a[3]).unwrap()).unwrap();
            let lm = Lm::load(&ck, &device, &never).unwrap();
            let cache = Cache::new(&device, ids.len() as i64 + 8).unwrap();
            write_f32(&a[4], &lm.step(&device, &cache, &ids, 0).unwrap());
        }
        "dit" => {
            let ids: Vec<u32> = serde_json::from_slice(&std::fs::read(&a[3]).unwrap()).unwrap();
            let x = read_f32(&a[4]);
            let frames = x.len() / 64;
            let t: f32 = a[5].parse().unwrap();
            let lm = Lm::load(&ck, &device, &never).unwrap();
            let cond = Cache::new(&device, (ids.len() + frames + 2) as i64).unwrap();
            lm.prefill(&device, &cond, &ids).unwrap();
            drop(lm);
            let dit = Dit::load(&ck, &device, &never).unwrap();
            write_f32(
                &a[6],
                &dit.velocity(&device, &cond, ids.len() as i64, &x, t)
                    .unwrap(),
            );
        }
        "sample" => {
            let ids: Vec<u32> = serde_json::from_slice(&std::fs::read(&a[3]).unwrap()).unwrap();
            let x = read_f32(&a[4]);
            let frames = x.len() / 64;
            let lm = Lm::load(&ck, &device, &never).unwrap();
            let cond = Cache::new(&device, (ids.len() + frames + 2) as i64).unwrap();
            lm.prefill(&device, &cond, &ids).unwrap();
            drop(lm);
            let dit = Dit::load(&ck, &device, &never).unwrap();
            let out = delulu_music::shape(
                &dit,
                &device,
                &cond,
                ids.len() as i64,
                x,
                &never,
                &mut |_| {},
            )
            .unwrap();
            write_f32(&a[5], &out);
        }
        "vae" => {
            let latent = read_f32(&a[3]);
            let vae = delulu_music::vae::Vae::load(&ck, &device).unwrap();
            write_f32(
                &a[4],
                &vae.decode(&device, &latent, &never, &mut |_, _| {})
                    .unwrap(),
            );
        }
        _ => panic!("mode"),
    }
}
