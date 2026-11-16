# Included by CMake right after `project(llama.cpp)` when llama-cpp-sys-2 builds
# delulu-engine's one ggml (see .cargo/config.toml). Definitions that change the
# layout of ggml's structs must match in every user of that ggml: llama.cpp, ggml,
# the YuE2 code and acestep.cpp (crates/music-ace/build.rs reads the same value).
if(NOT GGML_MAX_NAME)
    message(FATAL_ERROR "GGML_MAX_NAME is not set; it comes from .cargo/config.toml")
endif()
add_compile_definitions(GGML_MAX_NAME=${GGML_MAX_NAME})
