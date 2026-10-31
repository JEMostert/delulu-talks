//! Token sampling for YuE2's two language-model phases and the random numbers used
//! throughout. The filters follow ComfyUI's YuE2 sampler: allowed-token mask, minimum
//! length, windowed repetition penalty, temperature, top-k, then top-p.

/// xoshiro256** seeded through splitmix64.
pub struct Rng {
    s: [u64; 4],
    spare: Option<f32>,
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut x = seed;
        let mut next = || {
            x = x.wrapping_add(0x9E3779B97F4A7C15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            z ^ (z >> 31)
        };
        Rng {
            s: [next(), next(), next(), next()],
            spare: None,
        }
    }
    pub fn u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }
    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 {
        (self.u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    /// Standard normal (Box-Muller).
    pub fn normal(&mut self) -> f32 {
        if let Some(v) = self.spare.take() {
            return v;
        }
        let u1 = self.uniform().max(1e-300);
        let u2 = self.uniform();
        let r = (-2.0 * u1.ln()).sqrt();
        let (s, c) = (std::f64::consts::TAU * u2).sin_cos();
        self.spare = Some((r * s) as f32);
        (r * c) as f32
    }
}

pub struct Sampling {
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: usize,
    pub repetition_penalty: f32,
    pub penalty_window: usize,
    /// The end token is not allowed before this many tokens.
    pub min_tokens: usize,
}

/// Pick the next token from `logits`. Only ids in `allowed` and `end` may be chosen.
pub fn pick(
    logits: &[f32],
    allowed: std::ops::Range<usize>,
    end: usize,
    history: &[u32],
    s: &Sampling,
    rng: &mut Rng,
) -> u32 {
    let mut ids: Vec<usize> = allowed.collect();
    if history.len() >= s.min_tokens {
        ids.push(end);
    }
    let mut counts = std::collections::HashMap::<u32, i32>::new();
    if s.repetition_penalty != 1.0 {
        for &t in history.iter().rev().take(s.penalty_window) {
            *counts.entry(t).or_default() += 1;
        }
    }
    let mut scored: Vec<(usize, f32)> = ids
        .into_iter()
        .map(|id| {
            let mut v = logits[id];
            if let Some(&c) = counts.get(&(id as u32)) {
                let p = s.repetition_penalty.powi(c);
                v = if v < 0.0 { v * p } else { v / p };
            }
            (id, v)
        })
        .collect();
    if s.temperature <= 0.0 {
        return scored
            .iter()
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map_or(end as u32, |&(id, _)| id as u32);
    }
    for v in scored.iter_mut() {
        v.1 /= s.temperature;
    }
    // Top-k keeps everything at least as large as the k-th score.
    let k = s.top_k.clamp(1, scored.len());
    scored.select_nth_unstable_by(k - 1, |a, b| b.1.total_cmp(&a.1));
    let threshold = scored[k - 1].1;
    scored.retain(|v| v.1 >= threshold);
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let max = scored[0].1;
    let mut probs: Vec<f64> = scored.iter().map(|v| ((v.1 - max) as f64).exp()).collect();
    let sum: f64 = probs.iter().sum();
    probs.iter_mut().for_each(|p| *p /= sum);
    if s.top_p < 1.0 {
        // Drop tokens whose preceding cumulative probability already exceeds top_p.
        let mut cumulative = 0.0;
        let mut keep = probs.len();
        for (i, p) in probs.iter().enumerate() {
            if i > 0 && cumulative > s.top_p as f64 {
                keep = i;
                break;
            }
            cumulative += p;
        }
        probs.truncate(keep);
        scored.truncate(keep);
        let sum: f64 = probs.iter().sum();
        probs.iter_mut().for_each(|p| *p /= sum);
    }
    let mut r = rng.uniform();
    for (i, p) in probs.iter().enumerate() {
        if r < *p {
            return scored[i].0 as u32;
        }
        r -= p;
    }
    scored[scored.len() - 1].0 as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn greedy() -> Sampling {
        Sampling {
            temperature: 0.0,
            top_p: 1.0,
            top_k: 10,
            repetition_penalty: 1.0,
            penalty_window: 10,
            min_tokens: 0,
        }
    }

    #[test]
    fn respects_allowed_range_and_minimum_length() {
        let logits = vec![9.0, 1.0, 2.0, 3.0, 8.0];
        let mut rng = Rng::new(1);
        let s = greedy();
        assert_eq!(pick(&logits, 1..4, 4, &[], &s, &mut rng), 4);
        let s = Sampling {
            min_tokens: 1,
            ..greedy()
        };
        assert_eq!(pick(&logits, 1..4, 4, &[], &s, &mut rng), 3);
    }

    #[test]
    fn penalty_and_top_k_shape_the_choice() {
        let logits = vec![2.0, 1.9, -5.0];
        let mut rng = Rng::new(7);
        let s = Sampling {
            repetition_penalty: 2.0,
            ..greedy()
        };
        assert_eq!(pick(&logits, 0..3, 2, &[0], &s, &mut rng), 1);
        let s = Sampling {
            temperature: 1.0,
            top_k: 1,
            ..greedy()
        };
        for _ in 0..20 {
            assert_eq!(pick(&logits, 0..3, 2, &[], &s, &mut rng), 0);
        }
    }

    #[test]
    fn normal_has_unit_variance() {
        let mut rng = Rng::new(3);
        let n = 20000;
        let v: Vec<f32> = (0..n).map(|_| rng.normal()).collect();
        let mean = v.iter().sum::<f32>() / n as f32;
        let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / n as f32;
        assert!(
            mean.abs() < 0.03 && (var - 1.0).abs() < 0.05,
            "{mean} {var}"
        );
    }
}
