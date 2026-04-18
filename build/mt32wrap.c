#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include "mt32emu.h"

static mt32emu_context ctx = NULL;

EMSCRIPTEN_KEEPALIVE
void synth_create(void) {
    if (ctx != NULL) {
        mt32emu_free_context(ctx);
        ctx = NULL;
    }
    ctx = mt32emu_create_context(NULL, NULL);
}

EMSCRIPTEN_KEEPALIVE
int synth_add_rom(const uint8_t *data, uint32_t len) {
    return mt32emu_add_rom_data(ctx, data, len, NULL);
}

EMSCRIPTEN_KEEPALIVE
int synth_open(double sample_rate) {
    mt32emu_set_stereo_output_samplerate(ctx, sample_rate);
    return mt32emu_open_synth(ctx);
}

EMSCRIPTEN_KEEPALIVE
uint32_t synth_get_samplerate(void) {
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
    mt32emu_play_msg(ctx, msg);
}

EMSCRIPTEN_KEEPALIVE
void synth_play_sysex(const uint8_t *data, uint32_t len) {
    mt32emu_play_sysex(ctx, data, len);
}

EMSCRIPTEN_KEEPALIVE
void synth_render(int16_t *buf, uint32_t samples) {
    if (ctx == NULL) {
        memset(buf, 0, samples * 2 * sizeof(int16_t));
        return;
    }
    mt32emu_render_bit16s(ctx, buf, samples);
}
