//! `delulu-engine llm`: runs Gemma 4 E4B through llama.cpp for transcript cleanup and
//! the radio writer.
//!
//! Serve mode: `delulu-engine llm --model <gguf>` reads one JSON `Request` per stdin
//! line and writes one JSON `Reply` per stdout line. Smoke mode:
//! `delulu-engine llm --model <gguf> [--vocab <term>]… --once <nl|en> <text…>`.

use std::fs::File;
use std::io::{BufRead, Write};
use std::num::NonZeroU32;
use std::os::fd::FromRawFd;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use delulu_cleanup::{
    max_tokens, prompt, prompt_with_prefix, sanitize, split_reply, PromptPrefix, Reply, Request,
    Sampling,
};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::session::{LlamaStateSeqFlags, SeqState};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::{list_llama_ggml_backend_devices, LlamaBackendDeviceType};

mod prefix;
use prefix::PrefixCache;

const N_CTX: u32 = 6144;
const N_BATCH: u32 = 2048;
/// Vulkan compiles pipelines on first use, per shape. Two cleans of different lengths,
/// each decoding its language's prompt prefix in one batch and then the transcript in
/// a small one, cover what later requests need. On a cold shader cache they take about
/// 45 s (RTX 5060 Ti); without them the first real clean paid that. They also leave
/// both languages' prefixes cached for an empty vocabulary; the app then warms its own.
const WARM_UPS: [(&str, &str); 2] = [
    ("en", "uh so this is a quick warm up test"),
    (
        "nl",
        "eh dit is ehm een korte test om het model op te warmen nee wacht om alles klaar te zetten voor het echte werk",
    ),
];

const USAGE: &str =
    "usage: delulu-engine llm --model <gguf> [--vocab <term>]… [--once <nl|en> <text…>]";

struct Args {
    model: PathBuf,
    once: Option<(String, String)>,
    /// Vocabulary terms for `--once`; serve mode gets them inside each prompt.
    vocab: Vec<String>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut model = None;
    let mut once = None;
    let mut vocab = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => model = args.next().map(PathBuf::from),
            "--vocab" => vocab.push(args.next().ok_or("--vocab needs a term")?),
            "--once" => {
                let language = args.next().ok_or("--once needs a language")?;
                let text = args.by_ref().collect::<Vec<_>>().join(" ");
                once = Some((language, text));
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let model = model.ok_or(USAGE)?;
    if !vocab.is_empty() && once.is_none() {
        return Err(format!("--vocab only works with --once\n{USAGE}"));
    }
    Ok(Args { model, once, vocab })
}

/// Keep stdout for the protocol only: anything a C library prints goes to stderr.
pub(crate) fn protocol_out() -> File {
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

pub fn main(args: impl Iterator<Item = String>) -> ExitCode {
    let mut out = protocol_out();
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("delulu-engine llm: {message}");
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
        prefixes: PrefixCache::new(),
    };
    for (language, text) in WARM_UPS {
        let (warm, len) = prompt_with_prefix(language, text, &[]).expect("warm-up prompt");
        let prefix = PromptPrefix {
            len,
            slot: language.to_string(),
        };
        if let Err(e) = engine.generate(&warm, max_tokens(text), None, Some(&prefix)) {
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
            &args.vocab,
        );
    }

    send(
        &mut out,
        &Reply::Ready {
            backend: backend_label.clone(),
            load_ms,
        },
    );
    eprintln!("delulu-engine llm: ready ({backend_label}, {load_ms} ms)");
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(e) => {
                // Not `{e}`: serde can quote the dictated text it choked on.
                eprintln!(
                    "delulu-engine llm: bad request ({:?} error at column {})",
                    e.classify(),
                    e.column()
                );
                continue;
            }
        };
        let started = Instant::now();
        let reply = match engine.generate(
            &request.prompt,
            request.max_tokens,
            request.sampling,
            request.prefix.as_ref(),
        ) {
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
    eprintln!("delulu-engine llm: {message}");
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
    vocab: &[String],
) -> ExitCode {
    let Some(rendered) = prompt(language, text, vocab) else {
        eprintln!("delulu-engine llm: kept raw (unsupported language, empty or too long)");
        let _ = writeln!(out, "{text}");
        return ExitCode::SUCCESS;
    };
    let started = Instant::now();
    let (raw, truncated) = match engine.generate(&rendered, max_tokens(text), None, None) {
        Ok(result) => result,
        Err(e) => {
            eprintln!("delulu-engine llm: {e}");
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
    let (topic, reply) = split_reply(&raw);
    eprintln!("topic: {}", topic.as_deref().unwrap_or("(none)"));
    match sanitize(text, &reply, truncated) {
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
    /// Cleanup's evaluated prompt prefixes, in host memory.
    prefixes: PrefixCache<SeqState>,
}

impl Engine<'_> {
    /// Decode from a fresh KV cache, or from a cached `prefix` when the request has one:
    /// greedy, or seeded sampling when asked. Returns the text and whether `max_tokens`
    /// cut it off.
    fn generate(
        &mut self,
        prompt: &str,
        max_tokens: u32,
        sampling: Option<Sampling>,
        prefix: Option<&PromptPrefix>,
    ) -> Result<(String, bool), String> {
        let vocab = self.model.vocab();
        let tokens = vocab.tokenize(prompt.as_bytes(), true, true);
        if tokens.len() + max_tokens as usize > self.ctx.n_ctx() as usize {
            return Err(format!("prompt too long ({} tokens)", tokens.len()));
        }

        // Nothing of an earlier request, cleanup or writing, survives into this one.
        self.ctx.clear_kv_cache();
        let mut pos = match prefix {
            Some(prefix) => self.start_from_prefix(prompt, &tokens, prefix, max_tokens)?,
            None => 0,
        };
        let rest = &tokens[pos as usize..];
        for (i, chunk) in rest.chunks(N_BATCH as usize).enumerate() {
            let last_chunk = (i + 1) * N_BATCH as usize >= rest.len();
            self.decode(chunk, pos, last_chunk)?;
            pos += chunk.len() as i32;
        }
        if max_tokens == 0 {
            return Ok((String::new(), true));
        }

        let penalties = LlamaSampler::penalties(self.model.n_vocab(), 64, 1.1, 0.0, 0.0);
        let mut sampler = match sampling {
            // Temperature 0. Top-k first spares the penalties a pass over the whole
            // vocabulary; the result only differs if the penalties pushed all 40 best
            // tokens below the 41st. `sample` accepts only generated tokens.
            None => LlamaSampler::chain_simple([
                LlamaSampler::top_k(40),
                penalties,
                LlamaSampler::greedy(),
            ]),
            Some(s) => LlamaSampler::chain_simple([
                penalties,
                LlamaSampler::top_p(s.top_p.clamp(0.05, 1.0), 1),
                LlamaSampler::temp(s.temperature.clamp(0.0, 2.0)),
                LlamaSampler::dist(s.seed),
            ]),
        };
        let mut bytes = Vec::new();
        for _ in 0..max_tokens {
            let token = sampler.sample(&self.ctx, self.batch.n_tokens() - 1);
            if vocab.is_eog(token) {
                return Ok((String::from_utf8_lossy(&bytes).into_owned(), false));
            }
            vocab.token_to_piece_into(token, &mut bytes, true, None);
            self.decode(&[token], pos, true)?;
            pos += 1;
        }
        Ok((String::from_utf8_lossy(&bytes).into_owned(), true))
    }

    /// Put the KV state after the request's prefix in place, restored from the cache or
    /// decoded and cached now, and return how many prompt tokens it holds. 0 = the
    /// prefix cannot be used: decode the whole prompt.
    fn start_from_prefix(
        &mut self,
        prompt: &str,
        tokens: &[LlamaToken],
        prefix: &PromptPrefix,
        max_tokens: u32,
    ) -> Result<i32, String> {
        let Some(text) = prompt.get(..prefix.len) else {
            return Ok(0);
        };
        if let Some((cached, state)) = self.prefixes.get(&prefix.slot, text) {
            if !prefix::reusable(cached, tokens, max_tokens) {
                return Ok(0);
            }
            let n = cached.len() as i32;
            if self.ctx.state_seq_set(state, 0).is_ok() {
                return Ok(n);
            }
            eprintln!("delulu-engine llm: could not restore a cached prompt prefix");
            self.prefixes.remove(&prefix.slot);
            self.ctx.clear_kv_cache();
            return Ok(0);
        }

        let cached = self.model.vocab().tokenize(text.as_bytes(), true, true);
        if !prefix::reusable(&cached, tokens, max_tokens) {
            return Ok(0);
        }
        for (pos, chunk) in (0..)
            .step_by(N_BATCH as usize)
            .zip(cached.chunks(N_BATCH as usize))
        {
            self.decode(chunk, pos, false)?;
        }
        let n = cached.len() as i32;
        match self.ctx.state_seq_get(0, LlamaStateSeqFlags::empty()) {
            Ok(state) => {
                eprintln!(
                    "delulu-engine llm: cached a prompt prefix ({n} tokens, {:.1} MiB)",
                    state.byte_len() as f64 / (1024.0 * 1024.0)
                );
                self.prefixes.insert(&prefix.slot, text, cached, state);
            }
            Err(e) => eprintln!("delulu-engine llm: could not cache a prompt prefix: {e}"),
        }
        Ok(n)
    }

    /// Decode `tokens` at positions from `pos`, with logits for the last one if asked.
    fn decode(&mut self, tokens: &[LlamaToken], pos: i32, logits: bool) -> Result<(), String> {
        self.batch.clear();
        for (i, &token) in tokens.iter().enumerate() {
            let last = logits && i == tokens.len() - 1;
            self.batch
                .add(token, pos + i as i32, &[0], last)
                .map_err(|e| e.to_string())?;
        }
        self.ctx
            .decode(&mut self.batch)
            .map_err(|e| format!("decode: {e}"))
    }
}

/// Same format as stt: the first GPU llama.cpp registered, else "CPU".
pub fn backend_label() -> String {
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
