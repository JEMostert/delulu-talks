# Included by CMake right after `project(transcribe)` (build.rs sets
# CMAKE_PROJECT_transcribe_INCLUDE). transcribe.cpp links delulu-engine's one ggml,
# built by llama-cpp-sys-2 with GGML_MAX_NAME from .cargo/config.toml. That value
# changes `struct ggml_tensor`, so transcribe.cpp must be compiled with it too
# (vendor/whisper-rs-sys/shared-ggml.cmake does the same for whisper.cpp).
include_guard(GLOBAL)
if(NOT GGML_MAX_NAME)
    message(FATAL_ERROR "GGML_MAX_NAME is not set; it comes from .cargo/config.toml")
endif()
add_compile_definitions(GGML_MAX_NAME=${GGML_MAX_NAME} TRANSCRIBE_SHARED_GGML)
# `struct ggml_tensor` as transcribe.cpp's own objects see it, compiled into the
# library with their flags once the target exists. A deferred call expands its
# arguments when it runs, so the path is kept first.
set(DELULU_TRANSCRIBE_LAYOUT "${CMAKE_CURRENT_LIST_DIR}/layout.c")
cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}"
    CALL target_sources transcribe PRIVATE "${DELULU_TRANSCRIBE_LAYOUT}")
