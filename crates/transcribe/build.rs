//! Builds the vendored transcribe.cpp (vendor/transcribe.cpp, see vendor/README.md)
//! against the ggml that llama-cpp-sys-2 builds, so delulu-engine keeps one ggml,
//! plus the C shim the Rust side calls.
use std::env;
use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = root.join("../../vendor/transcribe.cpp");
    println!("cargo:rerun-if-changed={}", vendor.display());
    println!("cargo:rerun-if-changed=shared-ggml.cmake");
    println!("cargo:rerun-if-changed=layout.c");
    println!("cargo:rerun-if-changed=shim.c");

    // The value llama-cpp-sys-2 compiled ggml with (.cargo/config.toml).
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
    let prefix = cmake_dir
        .ancestors()
        .nth(2)
        .expect("ggml prefix")
        .to_path_buf();
    let ggml_include = prefix.join("include");
    assert!(
        ggml_include.join("ggml.h").is_file(),
        "no ggml.h in {}",
        ggml_include.display()
    );

    let mut config = cmake::Config::new(&vendor);
    config
        .profile("Release")
        .define("CMAKE_BUILD_TYPE", "Release")
        .define("TRANSCRIBE_USE_SYSTEM_GGML", "ON")
        .define("CMAKE_PREFIX_PATH", prefix.display().to_string())
        .define("GGML_MAX_NAME", &max_name)
        .define(
            "CMAKE_PROJECT_transcribe_INCLUDE",
            root.join("shared-ggml.cmake"),
        )
        .define("TRANSCRIBE_BUILD_TESTS", "OFF")
        .define("TRANSCRIBE_BUILD_EXAMPLES", "OFF")
        .define("TRANSCRIBE_BUILD_TOOLS", "OFF")
        .define("TRANSCRIBE_INSTALL", "OFF")
        // No system BLAS at runtime: the decoder's scalar fallback, as the official
        // binaries ship it.
        .define("TRANSCRIBE_USE_SYSTEM_BLAS", "OFF")
        .define("TRANSCRIBE_USE_OPENMP", "OFF")
        .define("BUILD_SHARED_LIBS", "OFF")
        .pic(true)
        .build_target("transcribe");
    let out = config.build();

    // The shim calls into libtranscribe, so it is named first on the link line;
    // llama-cpp-sys-2's ggml archives follow after both.
    cc::Build::new()
        .file(root.join("shim.c"))
        .include(vendor.join("include"))
        .include(&ggml_include)
        .define("TRANSCRIBE_STATIC", None)
        .define("GGML_MAX_NAME", max_name.as_str())
        .opt_level(2)
        .warnings(false)
        .compile("delulu_transcribe_shim");
    println!(
        "cargo:rustc-link-search=native={}",
        out.join("build/src").display()
    );
    println!("cargo:rustc-link-lib=static=transcribe");
    let cpp = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        "c++"
    } else {
        "stdc++"
    };
    println!("cargo:rustc-link-lib=dylib={cpp}");
}
