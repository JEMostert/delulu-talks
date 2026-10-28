//! `delulu-cleanup`: runs Gemma 4 E4B through llama.cpp for transcript cleanup.
//!
//! Serve mode: `delulu-cleanup --model <gguf>` reads one JSON `Request` per stdin line and
//! writes one JSON `Reply` per stdout line. Smoke mode:
//! `delulu-cleanup --model <gguf> --once <nl|en> <text…>`.

use std::fs::File;
use std::io::{BufRead, Write};
use std::num::NonZeroU32;
use std::os::fd::FromRawFd;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use delulu_cleanup::{max_tokens, prompt, sanitize, Reply, Request};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::{list_llama_ggml_backend_devices, LlamaBackendDeviceType};

const N_CTX: u32 = 6144;
const N_BATCH: u32 = 2048;
/// Vulkan compiles pipelines on first use, per shape. A short prompt (under 256 tokens)
/// and one that crosses the 256-token KV step cover what later requests need; with
/// only one, the first real clean on a cold shader cache took over 10 s.
const WARM_UPS: [(&str, &str); 2] = [
    ("en", "uh so this is a quick warm up test"),
    (
        "nl",
        "eh dit is ehm een korte test om het model op te warmen nee wacht om alles klaar te zetten voor het echte werk",
    ),
];

struct Args {
    model: PathBuf,
    once: Option<(String, String)>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = std::env::args().skip(1);
    let mut model = None;
    let mut once = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => model = args.next().map(PathBuf::from),
            "--once" => {
                let language = args.next().ok_or("--once needs a language")?;
                let text = args.by_ref().collect::<Vec<_>>().join(" ");
                once = Some((language, text));
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let model = model.ok_or("usage: delulu-cleanup --model <gguf> [--once <nl|en> <text…>]")?;
    Ok(Args { model, once })
}

/// Keep stdout for the protocol only: anything a C library prints goes to stderr.
fn protocol_out() -> File {
    // SAFETY: plain fd syscalls on fds this process owns; the dup'd fd is owned by File.
    unsafe {
        let fd = libc::dup(libc::STDOUT_FILENO);
        assert!(fd >= 0, "dup stdout");
        libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO);
        File::from_raw_fd(fd)
    }
}

fn send(out: &mut File, reply: &Reply) {
    let line = serde_json::to_string(reply).expect("serialize reply");
    // A closed stdout means the app is gone; stdin EOF ends the loop next.
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}

fn main() -> ExitCode {
    let mut out = protocol_out();
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("delulu-cleanup: {message}");
            return ExitCode::from(2);
        }
    };

    let started = Instant::now();
    let mut backend = match LlamaBackend::init() {
        Ok(backend) => backend,
        Err(e) => return load_failed(&mut out, &format!("backend init: {e}")),
    };
    backend.void_logs();
    let model = match LlamaModel::load_from_file(
        &backend,
        &args.model,
        &LlamaModelParams::default().with_n_gpu_layers(u32::MAX),
    ) {
        Ok(model) => model,
        Err(e) => return load_failed(&mut out, &format!("{}: {e}", args.model.display())),
    };
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8)) as i32;
    let params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(N_CTX))
        .with_n_batch(N_BATCH)
        .with_n_threads(threads)
        .with_n_threads_batch(threads);
    let ctx = match model.new_context(&backend, params) {
        Ok(ctx) => ctx,
        Err(e) => return load_failed(&mut out, &format!("context: {e}")),
    };
    let mut engine = Engine {
        model: &model,
        ctx,
        batch: LlamaBatch::new(N_BATCH as usize, 1),
    };
    for (language, text) in WARM_UPS {
        let warm = prompt(language, text).expect("warm-up prompt");
        if let Err(e) = engine.generate(&warm, max_tokens(text)) {
            return load_failed(&mut out, &format!("warm-up: {e}"));
        }
    }
    let backend_label = backend_label();
    let load_ms = started.elapsed().as_millis() as u64;

    if let Some((language, text)) = args.once {
        return once(
            &mut out,
            &mut engine,
            &backend_label,
            load_ms,
            &language,
            &text,
        );
    }

    send(
        &mut out,
        &Reply::Ready {
            backend: backend_label.clone(),
            load_ms,
        },
    );
    eprintln!("delulu-cleanup: ready ({backend_label}, {load_ms} ms)");
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(e) => {
                eprintln!("delulu-cleanup: bad request: {e}");
                continue;
            }
        };
        let started = Instant::now();
        let reply = match engine.generate(&request.prompt, request.max_tokens) {
            Ok((text, truncated)) => Reply::Result {
                id: request.id,
                text,
                truncated,
                ms: started.elapsed().as_millis() as u64,
            },
            Err(message) => Reply::Failed {
                id: request.id,
                message,
            },
        };
        send(&mut out, &reply);
    }
    ExitCode::SUCCESS
}

fn load_failed(out: &mut File, message: &str) -> ExitCode {
    eprintln!("delulu-cleanup: {message}");
    send(
        out,
        &Reply::Error {
            message: message.to_string(),
        },
    );
    ExitCode::FAILURE
}

fn once(
    out: &mut File,
    engine: &mut Engine,
    backend: &str,
    load_ms: u64,
    language: &str,
    text: &str,
) -> ExitCode {
    let Some(rendered) = prompt(language, text) else {
        eprintln!("delulu-cleanup: kept raw (unsupported language, empty or too long)");
        let _ = writeln!(out, "{text}");
        return ExitCode::SUCCESS;
    };
    let started = Instant::now();
    let (raw, truncated) = match engine.generate(&rendered, max_tokens(text)) {
        Ok(result) => result,
        Err(e) => {
            eprintln!("delulu-cleanup: {e}");
            return ExitCode::FAILURE;
        }
    };
    let clean_ms = started.elapsed().as_millis();
    let tokens = engine
        .model
        .vocab()
        .tokenize(rendered.as_bytes(), true, true)
        .len();
    eprintln!(
        "backend: {backend}\nload: {load_ms} ms\nclean: {clean_ms} ms ({tokens} prompt tokens)"
    );
    match sanitize(text, &raw, truncated) {
        Some(clean) => {
            let _ = writeln!(out, "{clean}");
        }
        None => {
            eprintln!("kept raw (model said {raw:?}, truncated {truncated})");
            let _ = writeln!(out, "{text}");
        }
    }
    ExitCode::SUCCESS
}

struct Engine<'m> {
    model: &'m LlamaModel,
    ctx: LlamaContext<'m>,
    batch: LlamaBatch<'static>,
}

impl Engine<'_> {
    /// Greedy decode from a fresh KV cache. Returns the text and whether
    /// `max_tokens` cut it off.
    fn generate(&mut self, prompt: &str, max_tokens: u32) -> Result<(String, bool), String> {
        self.ctx.clear_kv_cache();
        let vocab = self.model.vocab();
        let tokens = vocab.tokenize(prompt.as_bytes(), true, true);
        if tokens.len() + max_tokens as usize > self.ctx.n_ctx() as usize {
            return Err(format!("prompt too long ({} tokens)", tokens.len()));
        }

        let mut pos = 0;
        for chunk in tokens.chunks(N_BATCH as usize) {
            self.batch.clear();
            for &token in chunk {
                let last = pos as usize == tokens.len() - 1;
                self.batch
                    .add(token, pos, &[0], last)
                    .map_err(|e| e.to_string())?;
                pos += 1;
            }
            self.ctx
                .decode(&mut self.batch)
                .map_err(|e| format!("decode: {e}"))?;
        }

        // Penalties then greedy = temperature 0. `sample` accepts only generated tokens.
        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::penalties(self.model.n_vocab(), 64, 1.1, 0.0, 0.0),
            LlamaSampler::greedy(),
        ]);
        let mut bytes = Vec::new();
        for _ in 0..max_tokens {
            let token = sampler.sample(&self.ctx, self.batch.n_tokens() - 1);
            if vocab.is_eog(token) {
                return Ok((String::from_utf8_lossy(&bytes).into_owned(), false));
            }
            vocab.token_to_piece_into(token, &mut bytes, true, None);
            self.batch.clear();
            self.batch
                .add(token, pos, &[0], true)
                .map_err(|e| e.to_string())?;
            pos += 1;
            self.ctx
                .decode(&mut self.batch)
                .map_err(|e| format!("decode: {e}"))?;
        }
        Ok((String::from_utf8_lossy(&bytes).into_owned(), true))
    }
}

/// Same format as stt: the first GPU llama.cpp registered, else "CPU".
fn backend_label() -> String {
    list_llama_ggml_backend_devices()
        .into_iter()
        .find(|dev| {
            matches!(
                dev.device_type,
                LlamaBackendDeviceType::Gpu | LlamaBackendDeviceType::IntegratedGpu
            )
        })
        .map_or_else(
            || "CPU".to_string(),
            |dev| {
                let backend = if dev.name.starts_with("CUDA") {
                    "CUDA"
                } else if dev.name.starts_with("Vulkan") {
                    "Vulkan"
                } else {
                    &dev.name
                };
                format!("{backend}: {}", dev.description)
            },
        )
}
