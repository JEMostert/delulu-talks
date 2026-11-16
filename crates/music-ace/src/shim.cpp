// shim.cpp: the C interface delulu-engine uses to run one ACE-Step song.
//
// One call runs the whole song in this process: the language model writes the
// audio codes, is freed, then the text encoder, DiT and VAE turn them into audio.
// Each stage gets its own model store, so the LM's memory is gone before the
// synthesis loads anything and the peak is the larger stage, not the sum.
//
// The vendored acestep.cpp polls a cancel callback between LM tokens, between
// DiT steps and between VAE tiles; the shim passes the stage along, so the same
// callback reports progress and asks to stop.

#include "backend.h"
#include "ggml.h"
#include "model-store.h"
#include "pipeline-lm.h"
#include "pipeline-synth.h"
#include "request.h"
#include "task-types.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <exception>
#include <string>

extern "C" {

enum { DELULU_ACE_OK = 0, DELULU_ACE_CANCELLED = 1, DELULU_ACE_FAILED = 2 };
enum { DELULU_ACE_STAGE_LM = 0, DELULU_ACE_STAGE_DIT = 1, DELULU_ACE_STAGE_VAE = 2 };

// Returns true to stop the song.
typedef bool (*delulu_ace_tick)(void * user, int stage);

struct delulu_ace_job {
    const char * caption;
    const char * lyrics;
    const char * language;  // "" lets the LM decide
    int          bpm;       // 0 lets the LM decide
    float        duration;  // seconds
    uint32_t     seed;      // LM and DiT
    const char * lm_path;
    const char * text_encoder_path;
    const char * dit_path;
    const char * vae_path;
    const char * device;  // ggml device name, NULL for the best one
    int          max_seq;
    int          vae_chunk;
};

struct delulu_ace_result {
    float *  samples;    // planar stereo [L0..LN, R0..RN], free with delulu_ace_result_free
    int      n_samples;  // per channel
    int      sample_rate;
    int      codes;      // audio codes the LM wrote (5 per second)
    int      bpm;        // what the song was made with, after the LM filled gaps
    char     keyscale[32];
    char     timesignature[16];
    uint64_t lm_ms;     // LM load and generation
    uint64_t dit_ms;    // synth load, text encoding and denoising
    uint64_t vae_ms;
    char     error[256];
};

int  delulu_ace_generate(const delulu_ace_job * job, delulu_ace_tick tick, void * user, delulu_ace_result * out);
void delulu_ace_result_free(delulu_ace_result * out);
size_t delulu_ace_tensor_size_here(void);
size_t delulu_ace_tensor_size_in_ggml(void);

}  // extern "C"

namespace {

struct Poll {
    delulu_ace_tick tick;
    void *          user;
    int             stage;
    bool            cancelled;
};

bool poll(void * data) {
    Poll * p = (Poll *) data;
    if (!p->cancelled && p->tick(p->user, p->stage)) {
        p->cancelled = true;
    }
    return p->cancelled;
}

uint64_t ms_since(std::chrono::steady_clock::time_point t) {
    return (uint64_t) std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t)
        .count();
}

void copy_text(char * dst, size_t size, const std::string & src) {
    snprintf(dst, size, "%s", src.c_str());
}

int count_codes(const std::string & codes) {
    if (codes.empty()) {
        return 0;
    }
    int n = 1;
    for (char c : codes) {
        n += c == ',';
    }
    return n;
}

int run(const delulu_ace_job * job, Poll & poll_state, delulu_ace_result * out) {
    auto fail = [&](const char * message) {
        copy_text(out->error, sizeof(out->error), message);
        return poll_state.cancelled ? DELULU_ACE_CANCELLED : DELULU_ACE_FAILED;
    };

    if (job->device && *job->device) {
        // backend_set_device keeps the pointer: give it storage that outlives the call.
        static std::string device;
        device = job->device;
        if (!backend_set_device(device.c_str())) {
            return fail("the compute device is gone");
        }
    }

    AceRequest req;
    request_init(&req);
    req.caption         = job->caption;
    req.lyrics          = job->lyrics;
    req.vocal_language  = job->language;
    req.bpm             = job->bpm;
    req.duration        = job->duration;
    req.seed            = job->seed;
    req.lm_seed         = job->seed;
    req.use_cot_caption = false;  // keep the writer's caption as it is

    // Stage 1: the language model writes metadata and audio codes.
    auto       t        = std::chrono::steady_clock::now();
    AceRequest enriched = req;
    {
        AceLmParams lp;
        ace_lm_default_params(&lp);
        lp.model_path = job->lm_path;
        lp.max_seq    = job->max_seq;
        lp.max_batch  = 1;

        ModelStore * store = store_create(EVICT_STRICT);
        AceLm *      lm    = ace_lm_load(store, &lp);
        if (!lm) {
            store_free(store);
            return fail("could not load the ACE-Step language model");
        }
        poll_state.stage = DELULU_ACE_STAGE_LM;
        int rc = ace_lm_generate(lm, &req, 1, &enriched, NULL, NULL, poll, &poll_state, LM_MODE_GENERATE);
        ace_lm_free(lm);
        store_free(store);
        if (rc != 0) {
            return fail("the ACE-Step language model failed");
        }
    }
    out->lm_ms = ms_since(t);
    out->codes = count_codes(enriched.audio_codes);
    out->bpm   = enriched.bpm;
    copy_text(out->keyscale, sizeof(out->keyscale), enriched.keyscale);
    copy_text(out->timesignature, sizeof(out->timesignature), enriched.timesignature);
    if (out->codes == 0) {
        return fail("the ACE-Step language model wrote no audio codes");
    }

    // Stage 2: text encoder, DiT, VAE. The LM is already freed.
    ModelStore *   store = store_create(EVICT_STRICT);
    AceSynthParams sp;
    ace_synth_default_params(&sp);
    sp.text_encoder_path = job->text_encoder_path;
    sp.dit_path          = job->dit_path;
    sp.vae_path          = job->vae_path;
    sp.vae_chunk         = job->vae_chunk;

    t                = std::chrono::steady_clock::now();
    AceSynth * synth = ace_synth_load(store, &sp);
    if (!synth) {
        store_free(store);
        return fail("could not load the ACE-Step synthesis models");
    }
    poll_state.stage     = DELULU_ACE_STAGE_DIT;
    AceSynthJob * stage2 = ace_synth_job_run_dit(synth, &enriched, NULL, 0, NULL, 0, NULL, 0, NULL, 0, 1, poll,
                                                 &poll_state);
    out->dit_ms          = ms_since(t);
    if (!stage2) {
        ace_synth_free(synth);
        store_free(store);
        return fail("ACE-Step denoising failed");
    }

    t                = std::chrono::steady_clock::now();
    poll_state.stage = DELULU_ACE_STAGE_VAE;
    AceAudio audio   = {};
    int      rc      = ace_synth_job_run_vae(synth, stage2, &audio, poll, &poll_state);
    out->vae_ms      = ms_since(t);
    ace_synth_job_free(stage2);
    ace_synth_free(synth);
    store_free(store);
    if (rc != 0 || !audio.samples || audio.n_samples <= 0) {
        ace_audio_free(&audio);
        // acestep.cpp's own CLI exited 0 without a file when the VAE buffer did not fit.
        return fail("ACE-Step decoding produced no audio (out of graphics memory?)");
    }
    out->samples     = audio.samples;
    out->n_samples   = audio.n_samples;
    out->sample_rate = audio.sample_rate;
    return DELULU_ACE_OK;
}

}  // namespace

extern "C" int delulu_ace_generate(const delulu_ace_job * job,
                                   delulu_ace_tick        tick,
                                   void *                 user,
                                   delulu_ace_result *    out) {
    memset(out, 0, sizeof(*out));
    Poll poll_state = { tick, user, DELULU_ACE_STAGE_LM, false };
    // No C++ exception may cross into Rust.
    try {
        return run(job, poll_state, out);
    } catch (const std::exception & e) {
        copy_text(out->error, sizeof(out->error), std::string("ACE-Step failed: ") + e.what());
    } catch (...) {
        copy_text(out->error, sizeof(out->error), "ACE-Step failed");
    }
    delulu_ace_result_free(out);
    return DELULU_ACE_FAILED;
}

extern "C" void delulu_ace_result_free(delulu_ace_result * out) {
    if (out->samples) {
        AceAudio audio = { out->samples, out->n_samples, out->sample_rate };
        ace_audio_free(&audio);
        out->samples = NULL;
    }
}

// struct ggml_tensor as this file sees it, with the shared GGML_MAX_NAME.
extern "C" size_t delulu_ace_tensor_size_here(void) {
    return sizeof(struct ggml_tensor);
}

// struct ggml_tensor as the linked ggml was compiled: a tensor's offset in a fresh
// context is the object header, and tensor_overhead is header plus tensor.
extern "C" size_t delulu_ace_tensor_size_in_ggml(void) {
    struct ggml_init_params params = { 4 * ggml_tensor_overhead(), NULL, true };
    struct ggml_context *   ctx    = ggml_init(params);
    if (!ctx) {
        return 0;
    }
    struct ggml_tensor * t      = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, 1);
    size_t               header = (size_t) ((char *) t - (char *) ggml_get_mem_buffer(ctx));
    ggml_free(ctx);
    return ggml_tensor_overhead() - header;
}
