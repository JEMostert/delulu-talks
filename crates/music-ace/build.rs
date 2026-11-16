//! Builds acestep.cpp's core library (vendor/acestep.cpp, pinned and patched, see
//! vendor.sh) and the C shim against the ggml that llama-cpp-sys-2 builds, so
//! delulu-engine keeps one ggml. The ggml headers come from llama-cpp-sys-2's
//! install, its libraries are already linked through that crate.
use std::env;
use std::path::PathBuf;

const CORE: [&str; 6] = [
    "request.cpp",
    "model-store.cpp",
    "pipeline-lm.cpp",
    "pipeline-synth.cpp",
    "pipeline-synth-ops.cpp",
    "pipeline-understand.cpp",
];

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = root.join("vendor/acestep.cpp");
    println!("cargo:rerun-if-changed=vendor");
    println!("cargo:rerun-if-changed=src/shim.cpp");

    // The same value llama-cpp-sys-2 compiled ggml with (.cargo/config.toml).
    println!("cargo:rerun-if-env-changed=GGML_MAX_NAME");
    let max_name = env::var("GGML_MAX_NAME").expect(
        "GGML_MAX_NAME is not set: build from the workspace, it comes from .cargo/config.toml",
    );

    // llama-cpp-sys-2 exports its ggml CMake package dir (<prefix>/lib*/cmake);
    // the headers are installed next to it in <prefix>/include.
    let cmake_dir = PathBuf::from(
        env::var("DEP_LLAMA_GGML_CMAKE_DIR")
            .expect("llama-cpp-sys-2 did not export DEP_LLAMA_GGML_CMAKE_DIR"),
    );
    let ggml_include = cmake_dir
        .ancestors()
        .nth(2)
        .expect("ggml prefix")
        .join("include");
    assert!(
        ggml_include.join("ggml.h").is_file(),
        "no ggml.h in {}",
        ggml_include.display()
    );

    let mut cpp = cc::Build::new();
    cpp.cpp(true)
        .std("c++17")
        // Upstream's Release flags; also in debug builds, where -O0 would make
        // the CPU parts of a song crawl.
        .opt_level(3)
        .define("NDEBUG", None)
        .define("GGML_MAX_NAME", max_name.as_str())
        .include(vendor.join("src"))
        .include(vendor.join("vendor/yyjson"))
        .include(&ggml_include)
        .warnings(false)
        .flag_if_supported("-w");
    for file in CORE {
        cpp.file(vendor.join("src").join(file));
    }
    cpp.file(root.join("src/shim.cpp"));
    cpp.compile("delulu_acestep");

    // After the core library: a static library may only use the ones linked after it.
    let mut json = cc::Build::new();
    json.file(vendor.join("vendor/yyjson/yyjson.c"))
        .opt_level(3)
        .warnings(false)
        .flag_if_supported("-w")
        .compile("delulu_yyjson");
}
