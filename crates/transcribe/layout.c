// `struct ggml_tensor` as transcribe.cpp's objects see it: shared-ggml.cmake adds
// this file to the transcribe library, so it is compiled with transcribe.cpp's own
// flags. The Rust side compares it with the linked ggml before loading a model.
#include <stddef.h>

#include "ggml.h"

size_t delulu_transcribe_tensor_size(void) {
    return sizeof(struct ggml_tensor);
}
