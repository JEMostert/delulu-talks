#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
// Delulu: as a path dependency its lints are not capped like a crates.io crate's;
// the generated bindings trip these.
#![allow(unnecessary_transmutes, clippy::all)]

include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
