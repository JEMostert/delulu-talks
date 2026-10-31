//! Reads the YuE2 checkpoint (`yue2_3b_int8_convrot.safetensors`) and converts its
//! tensors to what the ggml graphs use. The INT8 linear weights keep their exact
//! values: each row becomes Q8_0 blocks with a scale of 1, and the row scale is
//! applied after the matrix product.
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::path::Path;

pub struct Entry {
    pub dtype: String,
    pub shape: Vec<usize>,
    start: u64,
    end: u64,
}

pub struct Checkpoint {
    file: File,
    base: u64,
    pub entries: HashMap<String, Entry>,
    pub metadata: HashMap<String, String>,
}

impl Checkpoint {
    pub fn open(path: &Path) -> Result<Checkpoint, String> {
        let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut len = [0u8; 8];
        file.read_exact_at(&mut len, 0)
            .map_err(|e| format!("checkpoint header: {e}"))?;
        let len = u64::from_le_bytes(len);
        if len > 100_000_000 {
            return Err("checkpoint header is not safetensors".into());
        }
        let mut header = vec![0u8; len as usize];
        file.read_exact_at(&mut header, 8)
            .map_err(|e| format!("checkpoint header: {e}"))?;
        let header: HashMap<String, Value> =
            serde_json::from_slice(&header).map_err(|e| format!("checkpoint header: {e}"))?;
        let mut entries = HashMap::new();
        let mut metadata = HashMap::new();
        for (name, value) in header {
            if name == "__metadata__" {
                if let Some(map) = value.as_object() {
                    for (k, v) in map {
                        metadata.insert(k.clone(), v.as_str().unwrap_or_default().to_string());
                    }
                }
                continue;
            }
            let dtype = value["dtype"].as_str().unwrap_or_default().to_string();
            let shape = value["shape"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_u64)
                        .map(|v| v as usize)
                        .collect()
                })
                .unwrap_or_default();
            let offsets = value["data_offsets"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let (start, end) = match offsets.as_slice() {
                [a, b] => (a.as_u64().unwrap_or(0), b.as_u64().unwrap_or(0)),
                _ => return Err(format!("checkpoint tensor {name} has no offsets")),
            };
            entries.insert(
                name,
                Entry {
                    dtype,
                    shape,
                    start,
                    end,
                },
            );
        }
        Ok(Checkpoint {
            file,
            base: 8 + len,
            entries,
            metadata,
        })
    }

    pub fn entry(&self, name: &str) -> Result<&Entry, String> {
        self.entries
            .get(name)
            .ok_or_else(|| format!("the music model lacks {name}"))
    }

    pub fn shape(&self, name: &str) -> Result<Vec<usize>, String> {
        Ok(self.entry(name)?.shape.clone())
    }

    pub fn bytes(&self, name: &str) -> Result<Vec<u8>, String> {
        let e = self.entry(name)?;
        let mut out = vec![0u8; (e.end - e.start) as usize];
        self.file
            .read_exact_at(&mut out, self.base + e.start)
            .map_err(|err| format!("read {name}: {err}"))?;
        Ok(out)
    }

    /// Any float tensor as f32.
    pub fn f32(&self, name: &str) -> Result<Vec<f32>, String> {
        let dtype = self.entry(name)?.dtype.clone();
        let bytes = self.bytes(name)?;
        let pairs = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes(*b));
        Ok(match dtype.as_str() {
            "F32" => bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes(*b))
                .collect(),
            "BF16" => pairs.map(|v| f32::from_bits((v as u32) << 16)).collect(),
            "F16" => pairs.map(|v| half::f16::from_bits(v).to_f32()).collect(),
            other => return Err(format!("{name}: unexpected dtype {other}")),
        })
    }

    /// An INT8 ConvRot linear: Q8_0 bytes with unit block scales, the per-row
    /// scales, and the rotation group size (0 when the weight is not rotated).
    pub fn int8_linear(&self, prefix: &str) -> Result<Linear8, String> {
        let name = format!("{prefix}.weight");
        let shape = self.shape(&name)?;
        let (rows, cols) = match shape.as_slice() {
            [r, c] => (*r, *c),
            _ => return Err(format!("{name}: not a matrix")),
        };
        if self.entry(&name)?.dtype != "I8" {
            return Err(format!("{name}: expected INT8 weights"));
        }
        let quant: Value = serde_json::from_slice(&self.bytes(&format!("{prefix}.comfy_quant"))?)
            .map_err(|e| format!("{prefix}: quantization info: {e}"))?;
        if quant["format"] != "int8_tensorwise" {
            return Err(format!(
                "{prefix}: unsupported quantization {}",
                quant["format"]
            ));
        }
        let group = if quant["convrot"].as_bool().unwrap_or(false) {
            quant["convrot_groupsize"].as_u64().unwrap_or(256) as usize
        } else {
            0
        };
        let scale = self.f32(&format!("{prefix}.weight_scale"))?;
        if scale.len() != rows {
            return Err(format!("{prefix}: expected one scale per row"));
        }
        if cols % 32 != 0 || (group > 0 && cols % group != 0) {
            return Err(format!("{prefix}: unsupported width {cols}"));
        }
        let raw = self.bytes(&name)?;
        let one = half::f16::from_f32(1.0).to_bits().to_le_bytes();
        let mut q8 = Vec::with_capacity(rows * cols / 32 * 34);
        for block in raw.as_chunks::<32>().0 {
            q8.extend_from_slice(&one);
            q8.extend_from_slice(block);
        }
        let bias = if self.entries.contains_key(&format!("{prefix}.bias")) {
            Some(self.f32(&format!("{prefix}.bias"))?)
        } else {
            None
        };
        Ok(Linear8 {
            rows,
            cols,
            q8,
            scale,
            group,
            bias,
        })
    }
}

pub struct Linear8 {
    pub rows: usize,
    pub cols: usize,
    /// Q8_0 blocks, row-major, block scale 1.
    pub q8: Vec<u8>,
    pub scale: Vec<f32>,
    pub group: usize,
    pub bias: Option<Vec<f32>>,
}

/// The normalized "regular" Hadamard matrix ConvRot uses (Kronecker powers of a 4x4
/// matrix). It is symmetric and its own inverse.
pub fn hadamard(size: usize) -> Vec<f32> {
    let h4: [[f32; 4]; 4] = [
        [1.0, 1.0, 1.0, -1.0],
        [1.0, 1.0, -1.0, 1.0],
        [1.0, -1.0, 1.0, 1.0],
        [-1.0, 1.0, 1.0, 1.0],
    ];
    let mut h = vec![1.0f32];
    let mut n = 1;
    while n < size {
        let mut next = vec![0.0f32; n * 4 * n * 4];
        for i in 0..n {
            for j in 0..n {
                for a in 0..4 {
                    for b in 0..4 {
                        next[(i * 4 + a) * n * 4 + j * 4 + b] = h[i * n + j] * h4[a][b];
                    }
                }
            }
        }
        h = next;
        n *= 4;
    }
    assert_eq!(n, size, "Hadamard size must be a power of 4");
    let norm = 1.0 / (size as f32).sqrt();
    h.iter().map(|v| v * norm).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hadamard_is_symmetric_and_orthonormal() {
        let n = 16;
        let h = hadamard(n);
        for i in 0..n {
            for j in 0..n {
                assert_eq!(h[i * n + j], h[j * n + i]);
                let dot: f32 = (0..n).map(|k| h[i * n + k] * h[k * n + j]).sum();
                let want = if i == j { 1.0 } else { 0.0 };
                assert!((dot - want).abs() < 1e-5);
            }
        }
    }
}
