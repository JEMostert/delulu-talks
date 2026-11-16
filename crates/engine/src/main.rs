//! `delulu-engine`: the app's model worker. The first argument picks the role, and one
//! process runs one role, so each role frees its graphics memory when it exits.
//!
//! - `delulu-engine llm …`: transcript cleanup and the radio writer (llama.cpp).
//! - `delulu-engine music …`: Delulu FM's music (YuE2, or ACE-Step 1.5 through the
//!   vendored acestep.cpp), one song per process.
//! - `delulu-engine tts …`: Supertonic 3 speech on the CPU (ONNX Runtime), for
//!   `delulu speak` and Delulu FM's host.
//! - `delulu-engine stt`: dictation's speech to text (Whisper through whisper.cpp,
//!   or Parakeet), resident while dictation is on; speaks the worker protocol.
//! - `delulu-engine probe`: version, roles and compute devices as JSON; loads no model.
use std::process::ExitCode;

mod llm;
mod music;
mod stt;
mod tts;

const ROLES: [&str; 4] = ["llm", "music", "stt", "tts"];
const USAGE: &str = "usage: delulu-engine <llm|music|stt|tts|probe> …";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("llm") => llm::main(args),
        Some("music") => music::main(args),
        Some("stt") => stt::main(args),
        Some("tts") => tts::main(args),
        Some("probe") => probe(),
        Some("--version") => {
            println!("delulu-engine {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// For release checks: proves the binary starts and sees its devices.
fn probe() -> ExitCode {
    let backends: Vec<_> = llama_cpp_2::list_llama_ggml_backend_devices()
        .into_iter()
        .map(|dev| {
            serde_json::json!({
                "name": dev.name,
                "backend": dev.backend,
                "description": dev.description,
                "type": format!("{:?}", dev.device_type).to_lowercase(),
                "freeBytes": dev.memory_free,
                "totalBytes": dev.memory_total,
            })
        })
        .collect();
    let device = llm::backend_label();
    let report = serde_json::json!({
        "engine": "delulu-engine",
        "version": env!("CARGO_PKG_VERSION"),
        "roles": ROLES,
        "gpu": device != "CPU",
        "device": device,
        "backends": backends,
    });
    println!("{report}");
    ExitCode::SUCCESS
}
