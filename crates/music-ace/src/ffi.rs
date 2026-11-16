//! The C shim (`shim.cpp`) and ggml device queries.
use crate::{Device, Plan, Raw, RunError, Stage};
use llama_cpp_sys_2 as sys;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

const OK: c_int = 0;
const CANCELLED: c_int = 1;

#[repr(C)]
struct Job {
    caption: *const c_char,
    lyrics: *const c_char,
    language: *const c_char,
    bpm: c_int,
    duration: f32,
    seed: u32,
    lm_path: *const c_char,
    text_encoder_path: *const c_char,
    dit_path: *const c_char,
    vae_path: *const c_char,
    device: *const c_char,
    max_seq: c_int,
    vae_chunk: c_int,
}

#[repr(C)]
struct Result_ {
    samples: *mut f32,
    n_samples: c_int,
    sample_rate: c_int,
    codes: c_int,
    bpm: c_int,
    keyscale: [c_char; 32],
    timesignature: [c_char; 16],
    lm_ms: u64,
    dit_ms: u64,
    vae_ms: u64,
    error: [c_char; 256],
}

type Tick = unsafe extern "C" fn(user: *mut c_void, stage: c_int) -> bool;

extern "C" {
    fn delulu_ace_generate(job: *const Job, tick: Tick, user: *mut c_void, out: *mut Result_) -> c_int;
    fn delulu_ace_result_free(out: *mut Result_);
    fn delulu_ace_tensor_size_here() -> usize;
    fn delulu_ace_tensor_size_in_ggml() -> usize;
}

/// True when acestep.cpp and the linked ggml agree on `struct ggml_tensor`, i.e.
/// both were compiled with the same GGML_MAX_NAME. A mismatch corrupts memory, so
/// the engine checks this before every song.
pub fn tensor_layout_matches() -> bool {
    // SAFETY: both functions only read sizes; the second makes and frees a tiny
    // no-alloc ggml context.
    unsafe { delulu_ace_tensor_size_here() == delulu_ace_tensor_size_in_ggml() }
}

unsafe extern "C" fn tick_trampoline(user: *mut c_void, stage: c_int) -> bool {
    // SAFETY: `user` is the `&mut dyn FnMut` that `run` passed and outlives the call.
    let tick = unsafe { &mut *(user as *mut &mut dyn FnMut(Stage) -> bool) };
    let stage = match stage {
        0 => Stage::Lm,
        1 => Stage::Dit,
        _ => Stage::Vae,
    };
    tick(stage)
}

fn c_string(text: &str) -> Result<CString, RunError> {
    CString::new(text).map_err(|_| RunError::Failed("text contains a NUL byte".into()))
}

fn c_path(path: &Path) -> Result<CString, RunError> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| RunError::Failed(format!("bad path {}", path.display())))
}

fn text(buffer: &[c_char]) -> String {
    // SAFETY: the shim always NUL-terminates these fixed buffers (snprintf).
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn run(plan: &Plan, tick: &mut dyn FnMut(Stage) -> bool) -> Result<Raw, RunError> {
    if !tensor_layout_matches() {
        return Err(RunError::Failed(
            "delulu-engine was built with a ggml whose GGML_MAX_NAME differs from acestep.cpp's; \
             rebuild llama-cpp-sys-2 (cargo clean -p llama-cpp-sys-2)"
                .into(),
        ));
    }
    let caption = c_string(&plan.caption)?;
    let lyrics = c_string(&plan.lyrics)?;
    let language = c_string(&plan.language)?;
    let lm = c_path(&plan.lm_path)?;
    let text_encoder = c_path(&plan.text_encoder_path)?;
    let dit = c_path(&plan.dit_path)?;
    let vae = c_path(&plan.vae_path)?;
    let device = plan.device.name.as_deref().map(c_string).transpose()?;
    let job = Job {
        caption: caption.as_ptr(),
        lyrics: lyrics.as_ptr(),
        language: language.as_ptr(),
        bpm: plan.bpm as c_int,
        duration: plan.seconds,
        seed: plan.seed,
        lm_path: lm.as_ptr(),
        text_encoder_path: text_encoder.as_ptr(),
        dit_path: dit.as_ptr(),
        vae_path: vae.as_ptr(),
        device: device.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
        max_seq: plan.max_seq as c_int,
        vae_chunk: plan.vae_chunk as c_int,
    };
    let mut tick = tick;
    // SAFETY: zeroed is a valid Result_ (null pointer, zero numbers, empty strings).
    let mut out: Result_ = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer in `job` lives until this call returns; `user` points at
    // `tick`, which the trampoline uses only during the call.
    let rc = unsafe {
        delulu_ace_generate(
            &job,
            tick_trampoline,
            &mut tick as *mut &mut dyn FnMut(Stage) -> bool as *mut c_void,
            &mut out,
        )
    };
    let result = match rc {
        OK => {
            let len = out.n_samples.max(0) as usize * 2;
            let planar = if out.samples.is_null() {
                Vec::new()
            } else {
                // SAFETY: the shim returns 2 * n_samples floats at `samples`.
                unsafe { std::slice::from_raw_parts(out.samples, len) }.to_vec()
            };
            Ok(Raw {
                planar,
                sample_rate: out.sample_rate.max(0) as u32,
                codes: out.codes.max(0) as usize,
                bpm: out.bpm.max(0) as u32,
                keyscale: text(&out.keyscale),
                timesignature: text(&out.timesignature),
                lm_ms: out.lm_ms,
                dit_ms: out.dit_ms,
                vae_ms: out.vae_ms,
            })
        }
        CANCELLED => Err(RunError::Cancelled),
        _ => Err(RunError::Failed(text(&out.error))),
    };
    // SAFETY: frees what the shim allocated, once; null-safe.
    unsafe { delulu_ace_result_free(&mut out) };
    result
}

pub(crate) fn best_device() -> Device {
    let cpu = Device {
        name: None,
        description: "CPU".into(),
        free: None,
    };
    if std::env::var_os("DELULU_MUSIC_CPU").is_some() {
        return Device {
            name: Some("CPU".into()),
            ..cpu
        };
    }
    // SAFETY: ggml's device registry: plain queries, the strings it returns are static.
    unsafe {
        sys::ggml_backend_load_all();
        let mut best: Option<(usize, sys::ggml_backend_dev_t)> = None;
        for i in 0..sys::ggml_backend_dev_count() {
            let dev = sys::ggml_backend_dev_get(i);
            if sys::ggml_backend_dev_type(dev) != sys::GGML_BACKEND_DEVICE_TYPE_GPU {
                continue;
            }
            let (mut free, mut total) = (0usize, 0usize);
            sys::ggml_backend_dev_memory(dev, &mut free, &mut total);
            if best.is_none_or(|(f, _)| free > f) {
                best = Some((free, dev));
            }
        }
        match best {
            Some((free, dev)) => Device {
                name: Some(
                    CStr::from_ptr(sys::ggml_backend_dev_name(dev))
                        .to_string_lossy()
                        .into_owned(),
                ),
                description: CStr::from_ptr(sys::ggml_backend_dev_description(dev))
                    .to_string_lossy()
                    .into_owned(),
                free: Some(free as u64),
            },
            None => Device {
                name: Some("CPU".into()),
                ..cpu
            },
        }
    }
}

/// Free memory of the planned device now; None for the CPU.
pub(crate) fn free_memory(device: &Device) -> Option<u64> {
    device.free?;
    let name = CString::new(device.name.as_deref()?).ok()?;
    // SAFETY: lookup by name in ggml's registry, then a memory query.
    unsafe {
        let dev = sys::ggml_backend_dev_by_name(name.as_ptr());
        if dev.is_null() {
            return None;
        }
        let (mut free, mut total) = (0usize, 0usize);
        sys::ggml_backend_dev_memory(dev, &mut free, &mut total);
        Some(free as u64)
    }
}
