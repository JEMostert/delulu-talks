//! Parakeet Ultra (Moondream's post-trained Parakeet TDT 0.6B v3) through the vendored
//! transcribe.cpp v0.4.2 (`vendor/transcribe.cpp`, MIT), built against
//! delulu-engine's one ggml. Only `delulu-engine stt` links this crate.
//!
//! The model takes 16 kHz mono audio and returns punctuated, cased text. It cuts
//! long recordings at pauses itself (its own voice-activity head), takes no prompt
//! and does not say which language it heard.
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::ptr::NonNull;

// whisper-rs-sys does the same: nothing here names llama-cpp-sys-2, and without
// this rustc would drop it and its ggml archives from the link line.
extern crate llama_cpp_sys_2;

#[repr(C)]
struct Handle {
    _private: [u8; 0],
}

type AbortCallback = unsafe extern "C" fn(*mut c_void) -> bool;

extern "C" {
    fn delulu_ultra_load(
        path: *const c_char,
        gpu: bool,
        threads: c_int,
        out: *mut *mut Handle,
        err: *mut c_char,
        len: usize,
    ) -> c_int;
    fn delulu_ultra_run(
        handle: *mut Handle,
        samples: *const f32,
        n: c_int,
        abort: Option<AbortCallback>,
        user: *mut c_void,
        text: *mut *const c_char,
        err: *mut c_char,
        len: usize,
    ) -> c_int;
    fn delulu_ultra_backend(handle: *const Handle) -> *const c_char;
    fn delulu_ultra_free(handle: *mut Handle);
    /// `sizeof(struct ggml_tensor)` as transcribe.cpp was compiled (layout.c).
    fn delulu_transcribe_tensor_size() -> usize;
    fn ggml_tensor_overhead() -> usize;
}

/// transcribe.cpp's status for an aborted run.
const ABORTED: c_int = 13;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The model or its backend could not be loaded.
    Load(String),
    /// A run failed.
    Run(String),
    /// The abort callback stopped the run.
    Aborted,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Load(e) | Self::Run(e) => f.write_str(e),
            Self::Aborted => f.write_str("cancelled"),
        }
    }
}

impl std::error::Error for Error {}

/// A loaded model with its session; one run at a time.
pub struct Ultra {
    handle: NonNull<Handle>,
    gpu: bool,
}

// The handle is only ever used through `&mut self` (and freed in Drop).
unsafe impl Send for Ultra {}

fn message(buffer: &[c_char]) -> String {
    // SAFETY: the shim always NUL-terminates the buffer (snprintf) or leaves it zeroed.
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

impl Ultra {
    /// Loads the GGUF at `path` on the graphics card (Vulkan) when `gpu`, else on
    /// the processor, with `threads` CPU threads.
    pub fn load(path: &Path, gpu: bool, threads: usize) -> Result<Self, Error> {
        if !tensor_layout_matches() {
            return Err(Error::Load(
                "delulu-engine was built with a ggml whose GGML_MAX_NAME differs from \
                 transcribe.cpp's; rebuild llama-cpp-sys-2 (cargo clean -p llama-cpp-sys-2)"
                    .into(),
            ));
        }
        use std::os::unix::ffi::OsStrExt;
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| Error::Load("model path contains a NUL byte".into()))?;
        let mut handle = std::ptr::null_mut();
        let mut err = [0 as c_char; 256];
        // SAFETY: valid C string and out pointers; the shim writes at most `len` bytes.
        let status = unsafe {
            delulu_ultra_load(
                path.as_ptr(),
                gpu,
                threads as c_int,
                &mut handle,
                err.as_mut_ptr(),
                err.len(),
            )
        };
        match NonNull::new(handle) {
            Some(handle) if status == 0 => Ok(Self { handle, gpu }),
            _ => Err(Error::Load(message(&err))),
        }
    }

    /// True when the model runs on the graphics card.
    pub fn on_gpu(&self) -> bool {
        self.gpu
    }

    /// transcribe.cpp's name for the device, like "Vulkan0" or "CPU".
    pub fn backend(&self) -> String {
        // SAFETY: the shim returns a string owned by the model, never NULL.
        unsafe { CStr::from_ptr(delulu_ultra_backend(self.handle.as_ptr())) }
            .to_string_lossy()
            .into_owned()
    }

    /// The text for 16 kHz mono `samples`. `abort` is asked between decoding steps.
    pub fn transcribe(
        &mut self,
        samples: &[f32],
        mut abort: impl FnMut() -> bool,
    ) -> Result<String, Error> {
        unsafe extern "C" fn trampoline(user: *mut c_void) -> bool {
            // SAFETY: `user` is the `&mut dyn FnMut` below, alive for the whole run.
            let abort = unsafe { &mut *(user as *mut &mut dyn FnMut() -> bool) };
            abort()
        }
        let n = c_int::try_from(samples.len()).map_err(|_| Error::Run("clip too long".into()))?;
        let mut abort: &mut dyn FnMut() -> bool = &mut abort;
        let mut text = std::ptr::null();
        let mut err = [0 as c_char; 256];
        // SAFETY: `samples` holds `n` floats; the callback and its data outlive the
        // call, after which the shim removes the callback.
        let status = unsafe {
            delulu_ultra_run(
                self.handle.as_ptr(),
                samples.as_ptr(),
                n,
                Some(trampoline),
                &mut abort as *mut &mut dyn FnMut() -> bool as *mut c_void,
                &mut text,
                err.as_mut_ptr(),
                err.len(),
            )
        };
        match status {
            0 if !text.is_null() => {
                // SAFETY: the text is owned by the session until the next run.
                Ok(unsafe { CStr::from_ptr(text) }
                    .to_string_lossy()
                    .into_owned())
            }
            ABORTED => Err(Error::Aborted),
            _ => Err(Error::Run(message(&err))),
        }
    }
}

impl Drop for Ultra {
    fn drop(&mut self) {
        // SAFETY: the handle came from delulu_ultra_load and is freed once.
        unsafe { delulu_ultra_free(self.handle.as_ptr()) }
    }
}

#[repr(C)]
struct InitParams {
    mem_size: usize,
    mem_buffer: *mut c_void,
    no_alloc: bool,
}

extern "C" {
    fn ggml_init(params: InitParams) -> *mut c_void;
    fn ggml_new_tensor_1d(ctx: *mut c_void, kind: c_int, n: i64) -> *mut c_void;
    fn ggml_get_mem_buffer(ctx: *const c_void) -> *mut c_void;
    fn ggml_free(ctx: *mut c_void);
}

/// transcribe.cpp and the linked ggml agree on `struct ggml_tensor`, which
/// `GGML_MAX_NAME` changes. A stale build cache can break that, and a model loaded
/// then would corrupt memory.
pub fn tensor_layout_matches() -> bool {
    const GGML_TYPE_F32: c_int = 0;
    // SAFETY: a tiny no-alloc context, freed again; the probe only returns a size.
    unsafe {
        let ctx = ggml_init(InitParams {
            mem_size: 4 * ggml_tensor_overhead(),
            mem_buffer: std::ptr::null_mut(),
            no_alloc: true,
        });
        if ctx.is_null() {
            return false;
        }
        // A tensor's offset in a fresh context is the object header; the overhead
        // is header plus tensor.
        let tensor = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);
        let header = (tensor as usize).wrapping_sub(ggml_get_mem_buffer(ctx) as usize);
        let in_ggml = ggml_tensor_overhead() - header;
        ggml_free(ctx);
        in_ggml == delulu_transcribe_tensor_size()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fails when transcribe.cpp was compiled without the GGML_MAX_NAME the linked
    /// ggml uses (shared-ggml.cmake missing, or a stale build cache).
    #[test]
    fn transcribe_and_the_linked_ggml_agree_on_tensor_layout() {
        assert!(tensor_layout_matches());
    }

    #[test]
    fn a_missing_model_is_a_load_error() {
        let err = Ultra::load(Path::new("/nonexistent/parakeet-ultra.gguf"), false, 1)
            .err()
            .expect("no model there");
        assert!(
            matches!(err, Error::Load(ref m) if !m.is_empty()),
            "{err:?}"
        );
    }
}
