#pragma once
// weight-ctx.h: format-independent weight loading context for ggml backends
//
// Manages a ggml_context for weight tensors + their backend buffer.
// Used by gguf-weights.h for all model loaders.
//
// Usage:
//   WeightCtx wctx;
//   wctx_init(&wctx, n_tensors);
//   ggml_tensor * w = <loader>_load_tensor(&wctx, source, "name");
//   wctx_alloc(&wctx, backend);

#include "ggml-backend.h"
#include "ggml.h"

#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <memory>
#include <vector>

struct WeightCtx {
    struct ggml_context * ctx;
    ggml_backend_buffer_t buffer;

    struct PendingCopy {
        struct ggml_tensor * tensor;
        const void *         src;
        size_t               nbytes;
        size_t               offset;  // byte offset into dst tensor (0 for regular loads)
        bool                 convert_bf16 = false;
    };

    std::vector<PendingCopy> pending;

    // Staging buffers for type-converted data, kept alive until wctx_alloc.
    // unique_ptr keeps the data address stable even when the outer vector grows,
    // so src pointers stored in pending stay valid across staging.push_back().
    std::vector<std::unique_ptr<float[]>> staging;
};

static void wctx_init(WeightCtx * wctx, int n_tensors) {
    size_t                  ctx_size = (size_t) n_tensors * ggml_tensor_overhead() + 1024;
    struct ggml_init_params params   = {
        /*.mem_size   =*/ctx_size,
        /*.mem_buffer =*/NULL,
        /*.no_alloc   =*/true,
    };
    wctx->ctx    = ggml_init(params);
    wctx->buffer = NULL;
    wctx->pending.clear();
    wctx->pending.reserve(n_tensors);
}

static bool wctx_alloc(WeightCtx * wctx, ggml_backend_t backend) {
    // Some Metal devices cannot keep BF16 leaves on their backend. Both
    // 16-bit formats have identical strides. Mark every slice of fused
    // weights before changing the shared destination tensor.
    for (auto & pc : wctx->pending) {
        pc.convert_bf16 = pc.tensor->type == GGML_TYPE_BF16 && !ggml_backend_supports_op(backend, pc.tensor);
    }
    for (const auto & pc : wctx->pending) {
        if (pc.convert_bf16) {
            pc.tensor->type = GGML_TYPE_F16;
        }
    }
    wctx->buffer = ggml_backend_alloc_ctx_tensors(wctx->ctx, backend);
    if (!wctx->buffer) {
        fprintf(stderr, "[WeightCtx] FATAL: failed to allocate backend buffer\n");
        return false;
    }
    // Mark as weight buffer so ggml_backend_sched assigns ops to the correct
    // backend based on weight location (avoids fallback through expansion).
    ggml_backend_buffer_set_usage(wctx->buffer, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
    size_t total = 0;
    std::vector<ggml_fp16_t> converted;
    for (auto & pc : wctx->pending) {
        if (pc.convert_bf16) {
            const auto * src = static_cast<const ggml_bf16_t *>(pc.src);
            size_t count = pc.nbytes / sizeof(*src);
            for (size_t i = 0; i < count;) {
                converted.resize(std::min<size_t>(count - i, 65536));
                for (size_t j = 0; j < converted.size(); ++j) {
                    converted[j] = ggml_fp32_to_fp16(ggml_bf16_to_fp32(src[i + j]));
                }
                ggml_backend_tensor_set(pc.tensor, converted.data(), pc.offset + i * sizeof(*src),
                                        converted.size() * sizeof(*src));
                i += converted.size();
            }
        } else {
            ggml_backend_tensor_set(pc.tensor, pc.src, pc.offset, pc.nbytes);
        }
        total += pc.nbytes;
    }
    fprintf(stderr, "[WeightCtx] Loaded %zu tensors, %.1f MB into backend\n", wctx->pending.size(),
            (float) total / (1024 * 1024));
    wctx->pending.clear();
    wctx->staging.clear();
    return true;
}

static void wctx_free(WeightCtx * wctx) {
    if (wctx->buffer) {
        ggml_backend_buffer_free(wctx->buffer);
    }
    if (wctx->ctx) {
        ggml_free(wctx->ctx);
    }
    wctx->buffer = NULL;
    wctx->ctx    = NULL;
}
