/*
 * mt32wrap.c — minimal C wrapper around the mt32emu C API.
 *
 * Deliberately avoids including mt32emu.h (which requires the CMake-generated
 * config.h).  All mt32emu functions are forward-declared here using the
 * primitive C types that correspond to the ABI types in libmt32emu.a.
 *
 *   mt32emu_bit8u  = unsigned char
 *   mt32emu_bit16s = short
 *   mt32emu_bit32u = unsigned int
 *   mt32emu_context = opaque pointer (void*)
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

/* ── mt32emu C API — forward declarations ────────────────────────────────── */

typedef void *mt32emu_context;

/* context lifetime */
extern mt32emu_context mt32emu_create_context(void *report_handler, void *instance_data);
extern void            mt32emu_free_context(mt32emu_context context);

/* ROM loading */
extern int  mt32emu_add_rom_data(mt32emu_context context,
                                  const unsigned char *data, size_t data_size,
                                  const void *sha1_digest);

/* sample-rate & open */
extern void         mt32emu_set_stereo_output_samplerate(mt32emu_context context, double samplerate);
extern unsigned int mt32emu_get_actual_stereo_output_samplerate(mt32emu_context context);
extern int          mt32emu_open_synth(mt32emu_context context);
extern void         mt32emu_close_synth(mt32emu_context context);

/* MIDI */
extern int mt32emu_play_msg  (mt32emu_context context, unsigned int msg);
extern int mt32emu_play_sysex(mt32emu_context context,
                               const unsigned char *sysex, unsigned int len);

/* render */
extern void mt32emu_render_bit16s(mt32emu_context context,
                                   short *stream, unsigned int len);

/* ── single global context ───────────────────────────────────────────────── */

static mt32emu_context ctx = NULL;

/* ── exported functions ──────────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
void synth_create(void) {
    if (ctx != NULL) {
        mt32emu_close_synth(ctx);
        mt32emu_free_context(ctx);
        ctx = NULL;
    }
    ctx = mt32emu_create_context(NULL, NULL);
}

EMSCRIPTEN_KEEPALIVE
int synth_add_rom(const uint8_t *data, uint32_t len) {
    if (ctx == NULL) return -1;
    return mt32emu_add_rom_data(ctx, data, (size_t)len, NULL);
}

EMSCRIPTEN_KEEPALIVE
int synth_open(double sample_rate) {
    if (ctx == NULL) return -1;
    mt32emu_set_stereo_output_samplerate(ctx, sample_rate);
    return mt32emu_open_synth(ctx);
}

EMSCRIPTEN_KEEPALIVE
uint32_t synth_get_samplerate(void) {
    if (ctx == NULL) return 32000;
    return mt32emu_get_actual_stereo_output_samplerate(ctx);
}

EMSCRIPTEN_KEEPALIVE
void synth_close(void) {
    if (ctx != NULL) {
        mt32emu_close_synth(ctx);
        mt32emu_free_context(ctx);
        ctx = NULL;
    }
}

EMSCRIPTEN_KEEPALIVE
void synth_play_msg(uint32_t msg) {
    if (ctx != NULL) mt32emu_play_msg(ctx, msg);
}

EMSCRIPTEN_KEEPALIVE
void synth_play_sysex(const uint8_t *data, uint32_t len) {
    if (ctx != NULL) mt32emu_play_sysex(ctx, data, len);
}

EMSCRIPTEN_KEEPALIVE
void synth_render(int16_t *buf, uint32_t samples) {
    if (ctx == NULL) {
        memset(buf, 0, (size_t)samples * 2 * sizeof(int16_t));
        return;
    }
    mt32emu_render_bit16s(ctx, buf, samples);
}
