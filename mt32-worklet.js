// mt32-worklet.js
// Loaded (concatenated with mt32emu.js) as an AudioWorklet module blob.
// MT32Module factory is available as a global from the concatenated mt32emu.js.

class MT32Processor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._ready    = false;
    this._mt32     = null;
    this._renderPtr = 0;
    this._pending  = [];   // queued midi/sysex messages received before init

    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  // ------------------------------------------------------------------ helpers

  _loadRom(heapu8, malloc, free, addRom, romData) {
    const bytes  = new Uint8Array(romData);
    const ptr    = malloc(bytes.byteLength);
    heapu8.set(bytes, ptr);
    const result = addRom(ptr, bytes.byteLength);
    free(ptr);
    return result;
  }

  // --------------------------------------------------------------- init logic

  _onMessage(msg) {
    switch (msg.type) {
      case 'init':
        this._initSynth(msg.wasmBinary, msg.ctrlRom, msg.pcmRom);
        break;
      case 'midi':
        if (this._ready) {
          this._mt32._synth_play_msg(msg.msg);
        } else {
          this._pending.push({ type: 'midi', msg: msg.msg });
        }
        break;
      case 'sysex': {
        if (this._ready) {
          this._playSysEx(msg.data);
        } else {
          this._pending.push({ type: 'sysex', data: msg.data });
        }
        break;
      }
      case 'panic':
        if (this._ready) {
          this._sendPanic();
        }
        break;
      default:
        break;
    }
  }

  _playSysEx(data) {
    const bytes  = new Uint8Array(data);
    const mt32   = this._mt32;
    const ptr    = mt32._malloc(bytes.byteLength);
    mt32.HEAPU8.set(bytes, ptr);
    mt32._synth_play_sysex(ptr, bytes.byteLength);
    mt32._free(ptr);
  }

  _sendPanic() {
    const mt32 = this._mt32;
    for (let ch = 0; ch < 16; ch++) {
      // CC 123 (All Notes Off) then CC 121 (Reset All Controllers)
      mt32._synth_play_msg(0xB0 | ch | (123 << 8) | (0 << 16));
      mt32._synth_play_msg(0xB0 | ch | (121 << 8) | (0 << 16));
    }
  }

  _flushPending() {
    for (const item of this._pending) {
      if (item.type === 'midi') {
        this._mt32._synth_play_msg(item.msg);
      } else if (item.type === 'sysex') {
        this._playSysEx(item.data);
      }
    }
    this._pending = [];
  }

  _initSynth(wasmBinary, ctrlRom, pcmRom) {
    MT32Module({ wasmBinary })
      .then((mt32) => {
        this._mt32 = mt32;

        // Load ROMs
        const ctrlOk = this._loadRom(
          mt32.HEAPU8, mt32._malloc, mt32._free,
          mt32._synth_add_rom.bind(mt32),
          ctrlRom
        );
        const pcmOk = this._loadRom(
          mt32.HEAPU8, mt32._malloc, mt32._free,
          mt32._synth_add_rom.bind(mt32),
          pcmRom
        );

        if (!ctrlOk || !pcmOk) {
          this.port.postMessage({ type: 'error', message: 'ROM loading failed' });
          return;
        }

        // Open synth at the AudioWorklet sample rate
        const opened = mt32._synth_open(sampleRate);
        if (!opened) {
          this.port.postMessage({ type: 'error', message: 'synth_open failed' });
          return;
        }

        // Allocate a permanent render buffer: 128 frames × 2 channels × 2 bytes (int16)
        this._renderPtr = mt32._malloc(128 * 4);

        this._ready = true;
        this._flushPending();

        this.port.postMessage({ type: 'ready', sampleRate });
      })
      .catch((err) => {
        this.port.postMessage({
          type: 'error',
          message: err && err.message ? err.message : String(err),
        });
      });
  }

  // --------------------------------------------------------------- DSP kernel

  process(_inputs, outputs) {
    const output     = outputs[0];
    const leftOut    = output[0];
    const rightOut   = output[1];
    const frameCount = leftOut ? leftOut.length : 128;

    if (!this._ready) {
      if (leftOut)  leftOut.fill(0);
      if (rightOut) rightOut.fill(0);
      return true;
    }

    const mt32 = this._mt32;
    mt32._synth_render(this._renderPtr, frameCount);

    // HEAP16 view — int16 stereo interleaved: [L0, R0, L1, R1, ...]
    const heap16 = mt32.HEAP16;
    const base   = this._renderPtr >> 1;   // byte ptr → int16 index
    const scale  = 1 / 32768;

    for (let i = 0; i < frameCount; i++) {
      leftOut[i]  = heap16[base + i * 2]     * scale;
      rightOut[i] = heap16[base + i * 2 + 1] * scale;
    }

    return true;
  }
}

registerProcessor('mt32-processor', MT32Processor);
