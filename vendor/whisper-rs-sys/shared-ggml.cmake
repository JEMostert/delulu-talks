# Included by CMake right after `project(whisper.cpp)` (build.rs sets
# CMAKE_PROJECT_whisper.cpp_INCLUDE). whisper.cpp links delulu-engine's one ggml,
# built by llama-cpp-sys-2 with GGML_MAX_NAME from .cargo/config.toml. That value
# changes `struct ggml_tensor`, so whisper.cpp must be compiled with it too
# (crates/music-ace/ggml.cmake does the same for llama.cpp's own build).
# whisper.cpp calls project() twice; this runs once.
include_guard(GLOBAL)
if(NOT GGML_MAX_NAME)
    message(FATAL_ERROR "GGML_MAX_NAME is not set; it comes from .cargo/config.toml")
endif()
add_compile_definitions(GGML_MAX_NAME=${GGML_MAX_NAME})
# `struct ggml_tensor` as whisper.cpp's own objects see it, compiled into libwhisper
# with their flags once the target exists; delulu-engine compares it with the
# linked ggml before it loads a model.
# A deferred call expands its arguments when it runs, so the path is kept first.
set(DELULU_WHISPER_LAYOUT "${CMAKE_CURRENT_LIST_DIR}/layout.c")
cmake_language(DEFER DIRECTORY "${CMAKE_SOURCE_DIR}"
    CALL target_sources whisper PRIVATE "${DELULU_WHISPER_LAYOUT}")
