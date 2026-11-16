#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
// Delulu: as a path dependency its lints are not capped like a crates.io crate's;
// the generated bindings trip these.
#![allow(unnecessary_transmutes, clippy::all)]

// Delulu: whisper.cpp links llama-cpp-sys-2's ggml. Nothing here names that crate,
// so without this rustc would drop it and its ggml archives from the link line.
extern crate llama_cpp_sys_2;

include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
