//! Times one language-model decode step by part: `bench <model>`.
use delulu_music::checkpoint::Checkpoint;
use delulu_music::ggml::Device;
use delulu_music::qwen::{Cache, Lm};
use delulu_music::sample::{pick, Rng, Sampling};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let device = Device::new(8).unwrap();
    let ck = Checkpoint::open(std::path::Path::new(&a[1])).unwrap();
    let lm = Lm::load(&ck, &device, &|| false).unwrap();
    let cache = Cache::new(&device, 4096).unwrap();
    let prefix: Vec<u32> = (0..600).map(|i| 1000 + i).collect();
    let mut logits = lm.step(&device, &cache, &prefix, 0).unwrap();
    let s = Sampling {
        temperature: 1.0,
        top_p: 0.95,
        top_k: 100,
        repetition_penalty: 1.2,
        penalty_window: 50,
        min_tokens: 0,
    };
    let mut rng = Rng::new(1);
    let mut history = Vec::new();
    let (mut t_step, mut t_pick) = (0f64, 0f64);
    let n = 200;
    for i in 0..n {
        let t = Instant::now();
        let tok = pick(
            &logits,
            151853..151853 + 32768,
            151852,
            &history,
            &s,
            &mut rng,
        );
        t_pick += t.elapsed().as_secs_f64();
        history.push(tok);
        let t = Instant::now();
        logits = lm.step(&device, &cache, &[tok], 600 + i).unwrap();
        t_step += t.elapsed().as_secs_f64();
    }
    println!(
        "per token: step {:.2} ms, pick {:.2} ms",
        t_step * 1e3 / n as f64,
        t_pick * 1e3 / n as f64
    );
}
