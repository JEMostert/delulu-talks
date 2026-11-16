// A small, stable C surface over transcribe.cpp's versioned parameter structs, so
// the Rust side never mirrors their layout. One model and one session per handle.
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <transcribe.h>

typedef struct delulu_ultra {
    struct transcribe_model *   model;
    struct transcribe_session * session;
} delulu_ultra;

static void set_error(char * err, size_t len, const char * what, int status) {
    if (err && len) {
        snprintf(err, len, "%s: %s", what, transcribe_status_string(status));
    }
}

// Registers the compiled-in backends once; later calls are no-ops in transcribe.cpp.
int delulu_ultra_load(const char * path, bool gpu, int threads, delulu_ultra ** out, char * err, size_t len) {
    *out = NULL;
    int st = transcribe_init_backends_default();
    if (st != TRANSCRIBE_OK) {
        set_error(err, len, "backends", st);
        return st;
    }
    struct transcribe_model_load_params lp;
    transcribe_model_load_params_init(&lp);
    lp.backend = gpu ? TRANSCRIBE_BACKEND_VULKAN : TRANSCRIBE_BACKEND_CPU;
    struct transcribe_model * model = NULL;
    st = transcribe_model_load_file(path, &lp, &model);
    if (st != TRANSCRIBE_OK) {
        set_error(err, len, "load", st);
        return st;
    }
    struct transcribe_session_params sp;
    transcribe_session_params_init(&sp);
    sp.n_threads = threads;
    struct transcribe_session * session = NULL;
    st = transcribe_session_init(model, &sp, &session);
    if (st != TRANSCRIBE_OK) {
        transcribe_model_free(model);
        set_error(err, len, "session", st);
        return st;
    }
    delulu_ultra * u = malloc(sizeof *u);
    if (!u) {
        transcribe_session_free(session);
        transcribe_model_free(model);
        set_error(err, len, "memory", TRANSCRIBE_ERR_OOM);
        return TRANSCRIBE_ERR_OOM;
    }
    u->model   = model;
    u->session = session;
    *out       = u;
    return TRANSCRIBE_OK;
}

// The text stays owned by the session until the next run or free.
int delulu_ultra_run(delulu_ultra * u, const float * samples, int n, transcribe_abort_callback abort, void * user,
                     const char ** text, char * err, size_t len) {
    *text = NULL;
    transcribe_set_abort_callback(u->session, abort, user);
    struct transcribe_run_params rp;
    transcribe_run_params_init(&rp);
    rp.timestamps = TRANSCRIBE_TIMESTAMPS_NONE;
    int st = transcribe_run(u->session, samples, n, &rp);
    transcribe_set_abort_callback(u->session, NULL, NULL);
    if (st != TRANSCRIBE_OK) {
        set_error(err, len, "transcribe", st);
        return st;
    }
    const char * t = transcribe_full_text(u->session);
    *text = t ? t : "";
    return TRANSCRIBE_OK;
}

const char * delulu_ultra_backend(const delulu_ultra * u) {
    const char * b = transcribe_model_backend(u->model);
    return b ? b : "";
}

void delulu_ultra_free(delulu_ultra * u) {
    if (u) {
        transcribe_session_free(u->session);
        transcribe_model_free(u->model);
        free(u);
    }
}
