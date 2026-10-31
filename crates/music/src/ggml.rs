//! A small safe layer over ggml (the tensor library inside llama.cpp, linked through
//! `llama-cpp-sys-2`): one GPU backend with the CPU as fallback, weight buffers, and
//! graphs built per step and run through the backend scheduler.
use llama_cpp_sys_2 as sys;
use std::ffi::{c_void, CStr, CString};
use std::ptr::null_mut;

pub use sys::GGML_TYPE_Q8_0 as Q8_0;
pub use sys::{GGML_TYPE_F16 as F16, GGML_TYPE_F32 as F32, GGML_TYPE_I32 as I32};

/// ggml.h: `GGML_ROPE_TYPE_NEOX` (a macro, so not in the bindings).
const ROPE_NEOX: i32 = 2;
/// Nodes a single graph may hold; the VAE tiles and 28-layer passes stay well below.
const GRAPH_NODES: usize = 16384;

/// A tensor handle inside a context. Copyable; valid while its context lives.
#[derive(Clone, Copy, Debug)]
pub struct T(pub *mut sys::ggml_tensor);

impl T {
    pub fn ne(self, i: usize) -> i64 {
        unsafe { (*self.0).ne[i] }
    }
    pub fn nb(self, i: usize) -> usize {
        unsafe { (*self.0).nb[i] }
    }
    pub fn nbytes(self) -> usize {
        unsafe { sys::ggml_nbytes(self.0) }
    }
    pub fn contiguous(self) -> bool {
        unsafe { sys::ggml_is_contiguous(self.0) }
    }
    /// Upload host data; the tensor must already be allocated.
    pub fn set<V: Copy>(self, data: &[V]) {
        let bytes = std::mem::size_of_val(data);
        assert_eq!(bytes, self.nbytes(), "tensor upload size");
        unsafe { sys::ggml_backend_tensor_set(self.0, data.as_ptr() as *const c_void, 0, bytes) }
    }
    pub fn set_bytes(self, offset: usize, data: &[u8]) {
        unsafe {
            sys::ggml_backend_tensor_set(self.0, data.as_ptr() as *const c_void, offset, data.len())
        }
    }
    pub fn get_f32(self) -> Vec<f32> {
        let n = self.nbytes() / 4;
        let mut out = vec![0f32; n];
        unsafe { sys::ggml_backend_tensor_get(self.0, out.as_mut_ptr() as *mut c_void, 0, n * 4) }
        out
    }
}

pub struct Device {
    pub gpu: Option<sys::ggml_backend_t>,
    pub cpu: sys::ggml_backend_t,
    pub name: String,
    sched: sys::ggml_backend_sched_t,
}

// The scheduler and backends are used from one thread at a time.
unsafe impl Send for Device {}

impl Device {
    /// The GPU with the most free memory, else the CPU alone.
    pub fn new(threads: usize) -> Result<Device, String> {
        unsafe {
            sys::ggml_backend_load_all();
            let mut best: Option<(usize, sys::ggml_backend_dev_t)> = None;
            for i in 0..sys::ggml_backend_dev_count() {
                let dev = sys::ggml_backend_dev_get(i);
                if sys::ggml_backend_dev_type(dev) != sys::GGML_BACKEND_DEVICE_TYPE_GPU
                    || std::env::var_os("DELULU_MUSIC_CPU").is_some()
                {
                    continue;
                }
                let (mut free, mut total) = (0usize, 0usize);
                sys::ggml_backend_dev_memory(dev, &mut free, &mut total);
                if best.is_none_or(|(f, _)| free > f) {
                    best = Some((free, dev));
                }
            }
            let cpu = sys::ggml_backend_cpu_init();
            if cpu.is_null() {
                return Err("could not start the CPU backend".into());
            }
            sys::ggml_backend_cpu_set_n_threads(cpu, threads.max(1) as i32);
            let (gpu, name) = match best {
                Some((_, dev)) => {
                    let backend = sys::ggml_backend_dev_init(dev, std::ptr::null());
                    if backend.is_null() {
                        (None, "CPU".to_string())
                    } else {
                        let desc = CStr::from_ptr(sys::ggml_backend_dev_description(dev))
                            .to_string_lossy()
                            .into_owned();
                        let kind = CStr::from_ptr(sys::ggml_backend_name(backend))
                            .to_string_lossy()
                            .into_owned();
                        (Some(backend), format!("{kind} ({desc})"))
                    }
                }
                None => (None, "CPU".to_string()),
            };
            let mut backends: Vec<sys::ggml_backend_t> = gpu.into_iter().chain([cpu]).collect();
            let sched = sys::ggml_backend_sched_new(
                backends.as_mut_ptr(),
                null_mut(),
                backends.len() as i32,
                GRAPH_NODES,
                false,
                true,
            );
            if sched.is_null() {
                return Err("could not create the ggml scheduler".into());
            }
            Ok(Device {
                gpu,
                cpu,
                name,
                sched,
            })
        }
    }

    /// Free and total memory of the GPU, if any.
    pub fn memory(&self) -> Option<(usize, usize)> {
        let gpu = self.gpu?;
        unsafe {
            let dev = sys::ggml_backend_get_device(gpu);
            let (mut free, mut total) = (0usize, 0usize);
            sys::ggml_backend_dev_memory(dev, &mut free, &mut total);
            Some((free, total))
        }
    }

    /// Where weights and caches live.
    fn main_backend(&self) -> sys::ggml_backend_t {
        self.gpu.unwrap_or(self.cpu)
    }

    /// Run a built graph. `inputs` uploads input tensors once they have memory.
    pub fn compute(&self, graph: &Graph, inputs: impl FnOnce()) -> Result<(), String> {
        unsafe {
            sys::ggml_backend_sched_reset(self.sched);
            if !sys::ggml_backend_sched_alloc_graph(self.sched, graph.gf) {
                return Err("out of memory for a compute graph".into());
            }
            inputs();
            let status = sys::ggml_backend_sched_graph_compute(self.sched, graph.gf);
            if status != sys::GGML_STATUS_SUCCESS {
                return Err(format!("ggml compute failed ({status})"));
            }
        }
        Ok(())
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        unsafe {
            sys::ggml_backend_sched_free(self.sched);
            if let Some(gpu) = self.gpu {
                sys::ggml_backend_free(gpu);
            }
            sys::ggml_backend_free(self.cpu);
        }
    }
}

/// Tensors that persist on the device: weights and caches.
pub struct Store {
    ctx: *mut sys::ggml_context,
    buffer: sys::ggml_backend_buffer_t,
}

unsafe impl Send for Store {}

/// Declares the tensors of a `Store` before its memory exists.
pub struct Layout {
    ctx: *mut sys::ggml_context,
}

impl Layout {
    pub fn new(tensors: usize) -> Layout {
        let params = sys::ggml_init_params {
            mem_size: unsafe { sys::ggml_tensor_overhead() } * (tensors + 16),
            mem_buffer: null_mut(),
            no_alloc: true,
        };
        Layout {
            ctx: unsafe { sys::ggml_init(params) },
        }
    }
    pub fn tensor(&self, kind: sys::ggml_type, ne: &[i64]) -> T {
        new_tensor(self.ctx, kind, ne)
    }
    /// Give every declared tensor memory on the device.
    pub fn allocate(self, device: &Device) -> Result<Store, String> {
        let buffer =
            unsafe { sys::ggml_backend_alloc_ctx_tensors(self.ctx, device.main_backend()) };
        let ctx = self.ctx;
        std::mem::forget(self);
        if buffer.is_null() {
            unsafe { sys::ggml_free(ctx) };
            return Err("not enough GPU memory for the music model".into());
        }
        unsafe {
            sys::ggml_backend_buffer_set_usage(buffer, sys::GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
        }
        Ok(Store { ctx, buffer })
    }
}

impl Drop for Layout {
    fn drop(&mut self) {
        unsafe { sys::ggml_free(self.ctx) }
    }
}

impl Store {
    pub fn bytes(&self) -> usize {
        unsafe { sys::ggml_backend_buffer_get_size(self.buffer) }
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        unsafe {
            sys::ggml_backend_buffer_free(self.buffer);
            sys::ggml_free(self.ctx);
        }
    }
}

fn new_tensor(ctx: *mut sys::ggml_context, kind: sys::ggml_type, ne: &[i64]) -> T {
    let t = unsafe {
        match *ne {
            [a] => sys::ggml_new_tensor_1d(ctx, kind, a),
            [a, b] => sys::ggml_new_tensor_2d(ctx, kind, a, b),
            [a, b, c] => sys::ggml_new_tensor_3d(ctx, kind, a, b, c),
            [a, b, c, d] => sys::ggml_new_tensor_4d(ctx, kind, a, b, c, d),
            _ => panic!("tensor rank"),
        }
    };
    assert!(!t.is_null(), "ggml tensor allocation");
    T(t)
}

/// One computation: its operations are recorded here, then run by `Device::compute`.
pub struct Graph {
    ctx: *mut sys::ggml_context,
    gf: *mut sys::ggml_cgraph,
}

impl Default for Graph {
    fn default() -> Self {
        Self::new()
    }
}

impl Graph {
    pub fn new() -> Graph {
        let size = unsafe {
            sys::ggml_tensor_overhead() * GRAPH_NODES
                + sys::ggml_graph_overhead_custom(GRAPH_NODES, false)
        };
        let ctx = unsafe {
            sys::ggml_init(sys::ggml_init_params {
                mem_size: size,
                mem_buffer: null_mut(),
                no_alloc: true,
            })
        };
        let gf = unsafe { sys::ggml_new_graph_custom(ctx, GRAPH_NODES, false) };
        Graph { ctx, gf }
    }

    /// An input filled after allocation.
    pub fn input(&self, kind: sys::ggml_type, ne: &[i64]) -> T {
        let t = new_tensor(self.ctx, kind, ne);
        unsafe { sys::ggml_set_input(t.0) };
        t
    }
    pub fn output(&self, t: T) -> T {
        unsafe {
            sys::ggml_set_output(t.0);
            sys::ggml_build_forward_expand(self.gf, t.0);
        }
        t
    }
    /// Make sure `t` is computed (e.g. a write into a cache).
    pub fn expand(&self, t: T) {
        unsafe { sys::ggml_build_forward_expand(self.gf, t.0) }
    }
    pub fn name(&self, t: T, name: &str) -> T {
        let c = CString::new(name).unwrap();
        unsafe { sys::ggml_set_name(t.0, c.as_ptr()) };
        t
    }

    // ---- operations ----
    /// Matrix product with F32 accumulation (Vulkan may otherwise accumulate in F16,
    /// which costs YuE2 about 30 dB of precision).
    pub fn mul_mat(&self, a: T, b: T) -> T {
        let t = unsafe { sys::ggml_mul_mat(self.ctx, a.0, b.0) };
        unsafe { sys::ggml_mul_mat_set_prec(t, sys::GGML_PREC_F32) };
        T(t)
    }
    pub fn add(&self, a: T, b: T) -> T {
        T(unsafe { sys::ggml_add(self.ctx, a.0, b.0) })
    }
    pub fn sub(&self, a: T, b: T) -> T {
        T(unsafe { sys::ggml_sub(self.ctx, a.0, b.0) })
    }
    pub fn mul(&self, a: T, b: T) -> T {
        T(unsafe { sys::ggml_mul(self.ctx, a.0, b.0) })
    }
    pub fn scale(&self, a: T, s: f32) -> T {
        T(unsafe { sys::ggml_scale(self.ctx, a.0, s) })
    }
    pub fn sin(&self, a: T) -> T {
        T(unsafe { sys::ggml_sin(self.ctx, a.0) })
    }
    pub fn sqr(&self, a: T) -> T {
        T(unsafe { sys::ggml_sqr(self.ctx, a.0) })
    }
    pub fn silu(&self, a: T) -> T {
        T(unsafe { sys::ggml_silu(self.ctx, a.0) })
    }
    pub fn swiglu(&self, a: T) -> T {
        T(unsafe { sys::ggml_swiglu(self.ctx, a.0) })
    }
    pub fn rms_norm(&self, a: T, eps: f32) -> T {
        T(unsafe { sys::ggml_rms_norm(self.ctx, a.0, eps) })
    }
    pub fn get_rows(&self, a: T, ids: T) -> T {
        T(unsafe { sys::ggml_get_rows(self.ctx, a.0, ids.0) })
    }
    pub fn cont(&self, a: T) -> T {
        T(unsafe { sys::ggml_cont(self.ctx, a.0) })
    }
    pub fn transpose(&self, a: T) -> T {
        T(unsafe { sys::ggml_transpose(self.ctx, a.0) })
    }
    pub fn permute(&self, a: T, p: [i32; 4]) -> T {
        T(unsafe { sys::ggml_permute(self.ctx, a.0, p[0], p[1], p[2], p[3]) })
    }
    pub fn cpy(&self, a: T, b: T) -> T {
        T(unsafe { sys::ggml_cpy(self.ctx, a.0, b.0) })
    }
    pub fn concat(&self, a: T, b: T, dim: i32) -> T {
        T(unsafe { sys::ggml_concat(self.ctx, a.0, b.0, dim) })
    }
    pub fn reshape(&self, a: T, ne: &[i64]) -> T {
        let a = if a.contiguous() { a } else { self.cont(a) };
        T(unsafe {
            match *ne {
                [x] => sys::ggml_reshape_1d(self.ctx, a.0, x),
                [x, y] => sys::ggml_reshape_2d(self.ctx, a.0, x, y),
                [x, y, z] => sys::ggml_reshape_3d(self.ctx, a.0, x, y, z),
                [x, y, z, w] => sys::ggml_reshape_4d(self.ctx, a.0, x, y, z, w),
                _ => panic!("reshape rank"),
            }
        })
    }
    /// A strided view; `nb` are the byte strides of dims 1.. and `offset` in bytes.
    pub fn view(&self, a: T, ne: &[i64], nb: &[usize], offset: usize) -> T {
        T(unsafe {
            match (ne, nb) {
                ([x], []) => sys::ggml_view_1d(self.ctx, a.0, *x, offset),
                ([x, y], [b1]) => sys::ggml_view_2d(self.ctx, a.0, *x, *y, *b1, offset),
                ([x, y, z], [b1, b2]) => {
                    sys::ggml_view_3d(self.ctx, a.0, *x, *y, *z, *b1, *b2, offset)
                }
                _ => panic!("view rank"),
            }
        })
    }
    pub fn rope_neox(&self, a: T, pos: T, dims: i32, base: f32) -> T {
        T(unsafe {
            sys::ggml_rope_ext(
                self.ctx,
                a.0,
                pos.0,
                null_mut(),
                dims,
                ROPE_NEOX,
                0,
                base,
                1.0,
                0.0,
                1.0,
                0.0,
                0.0,
            )
        })
    }
    /// Attention over `[D, T, H]` queries and `[D, S, Hkv]` keys and values.
    /// Returns `[D, H, T]`.
    pub fn attention(&self, q: T, k: T, v: T, mask: Option<T>, scale: f32) -> T {
        let t = unsafe {
            sys::ggml_flash_attn_ext(
                self.ctx,
                q.0,
                k.0,
                v.0,
                mask.map_or(null_mut(), |m| m.0),
                scale,
                0.0,
                0.0,
            )
        };
        unsafe { sys::ggml_flash_attn_ext_set_prec(t, sys::GGML_PREC_F32) };
        T(t)
    }
    pub fn timestep_embedding(&self, t: T, dim: i32) -> T {
        T(unsafe { sys::ggml_timestep_embedding(self.ctx, t.0, dim, 10000) })
    }
    /// 1-D convolution: kernel `[K, IC, OC]` (F16) over `[L, IC]`, giving `[L', OC]`.
    pub fn conv_1d(&self, kernel: T, x: T, stride: i32, pad: i32, dilation: i32) -> T {
        T(unsafe { sys::ggml_conv_1d(self.ctx, kernel.0, x.0, stride, pad, dilation) })
    }
    /// Scatter-add GEMM columns `[K*OC, L]` into `[(L-1)*s + K - 2p, OC]`.
    pub fn col2im_1d(&self, cols: T, stride: i32, channels: i32, pad: i32) -> T {
        T(unsafe { sys::ggml_col2im_1d(self.ctx, cols.0, stride, channels, pad) })
    }
}

impl Drop for Graph {
    fn drop(&mut self) {
        unsafe { sys::ggml_free(self.ctx) }
    }
}

/// f32 to IEEE half, round to nearest even.
pub fn f16_bits(v: f32) -> u16 {
    half::f16::from_f32(v).to_bits()
}
