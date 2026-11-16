// `struct ggml_tensor` as whisper.cpp's objects see it: shared-ggml.cmake adds this
// file to the whisper library, so it is compiled with whisper.cpp's own flags.
// delulu-engine compares the size with the linked ggml's before loading a model.
#include <stddef.h>

#include "ggml.h"

size_t delulu_whisper_tensor_size(void) {
    return sizeof(struct ggml_tensor);
}
