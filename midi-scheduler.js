// midi-scheduler.js
// Browser global — no module syntax.
// Usage: const sched = new MidiScheduler(parsedMidi, workletNode.port);

class MidiScheduler {
  /**
   * @param {object} parsedMidi  Output of MidiParser.parse()
   * @param {MessagePort} workletPort  AudioWorkletNode.port
   */
  constructor(parsedMidi, workletPort) {
    this._midi       = parsedMidi;
    this._port       = workletPort;

    // Playback state
    this._playing    = false;
    this._audioCtx   = null;

    // Position tracking
    // _startAudioTime: audioCtx.currentTime when current "segment" started
    // _startOffsetMs:  the elapsed-ms value at the moment play/resume began
    this._startAudioTime = 0;
    this._startOffsetMs  = 0;

    // Index of the next event to schedule
    this._nextEventIdx = 0;

    // Speed
    this._speed = 1.0;

    // Lookahead interval handle
    this._intervalId = null;

    // onEnded callback
    this._onEnded = null;

    // Pre-compute tempo segments and total duration once
    this._tempoSegments = this._buildTempoSegments();
    this._totalMs       = this._tickToMs(this._lastTick());
  }

  // ------------------------------------------------------------------
  // Public properties
  // ------------------------------------------------------------------

  get isPlaying() { return this._playing; }

  /** Elapsed playback time in seconds (accounts for speed). */
  get currentTimeSec() {
    if (!this._playing || !this._audioCtx) return this._startOffsetMs / 1000;
    const elapsed = (this._audioCtx.currentTime - this._startAudioTime) * 1000 * this._speed;
    return Math.min((this._startOffsetMs + elapsed) / 1000, this._totalMs / 1000);
  }

  get totalTimeSec() { return this._totalMs / 1000; }

  get playbackFraction() {
    if (this._totalMs === 0) return 0;
    return Math.min(Math.max(this.currentTimeSec / this.totalTimeSec, 0), 1);
  }

  set onEnded(cb) { this._onEnded = cb; }

  set speedMultiplier(v) {
    v = Math.min(8.0, Math.max(0.1, v));
    if (v === this._speed) return;

    if (this._playing && this._audioCtx) {
      // Snapshot current position before changing speed
      const currentMs = this.currentTimeSec * 1000;
      this._speed = v;
      this._restartFrom(currentMs);
    } else {
      this._speed = v;
      // Recompute total (speed doesn't affect total tick count but affects sec display)
    }
  }

  // ------------------------------------------------------------------
  // Public methods
  // ------------------------------------------------------------------

  /**
   * Start or resume playback.
   * @param {AudioContext} audioCtx
   */
  play(audioCtx) {
    if (this._playing) return;
    this._audioCtx = audioCtx;
    this._playing  = true;

    this._startAudioTime = audioCtx.currentTime;
    // _startOffsetMs already holds the resume position (set by pause/seek)
    // Advance _nextEventIdx to the correct position for the current offset
    this._syncEventIndex();

    this._startScheduler();
  }

  pause() {
    if (!this._playing) return;
    // Save position
    this._startOffsetMs = this.currentTimeSec * 1000;
    this._stopScheduler();
    this._playing = false;
    this._sendPanic();
  }

  stop() {
    this._stopScheduler();
    this._playing        = false;
    this._startOffsetMs  = 0;
    this._nextEventIdx   = 0;
    this._startAudioTime = 0;
    this._sendPanic();
  }

  /**
   * Seek to a fractional position (0.0–1.0).
   * @param {number} frac
   */
  seekFraction(frac) {
    frac = Math.min(1, Math.max(0, frac));
    const targetMs = frac * this._totalMs;
    const wasPlaying = this._playing;

    if (wasPlaying) {
      this._stopScheduler();
      this._sendPanic();
    }

    this._startOffsetMs = targetMs;
    this._syncEventIndex();

    if (wasPlaying && this._audioCtx) {
      this._playing        = true;
      this._startAudioTime = this._audioCtx.currentTime;
      this._startScheduler();
    }
  }

  // ------------------------------------------------------------------
  // Scheduler internals
  // ------------------------------------------------------------------

  _startScheduler() {
    const INTERVAL_MS  = 25;
    const LOOKAHEAD_MS = 100;

    this._intervalId = setInterval(() => {
      if (!this._playing || !this._audioCtx) return;

      const now        = this._audioCtx.currentTime;
      // How many ms of MIDI time have elapsed since the play segment started
      const segElapsed = (now - this._startAudioTime) * 1000 * this._speed;
      const currentMs  = this._startOffsetMs + segElapsed;
      const horizonMs  = currentMs + LOOKAHEAD_MS * this._speed;

      const events = this._midi.events;

      while (this._nextEventIdx < events.length) {
        const ev     = events[this._nextEventIdx];
        const evMs   = this._tickToMs(ev.absTick);

        if (evMs > horizonMs) break;

        this._nextEventIdx++;

        // Skip tempo events — they are handled by _tickToMs already
        if (ev.isTempo) continue;

        // Compute absolute AudioContext time for this event
        // evMs is in MIDI-speed ms; convert to wall-clock seconds
        const delayMs     = (evMs - currentMs) / this._speed;
        const scheduleAt  = now + Math.max(0, delayMs) / 1000;
        const delayForSet = Math.max(0, (scheduleAt - now) * 1000);

        if (ev.isSysEx) {
          const data = ev.sysExData;
          setTimeout(() => {
            this._port.postMessage({ type: 'sysex', data: data.buffer });
          }, delayForSet);
        } else {
          const msg = ev.msg;
          setTimeout(() => {
            this._port.postMessage({ type: 'midi', msg });
          }, delayForSet);
        }
      }

      // Check if we've reached the end
      if (this._nextEventIdx >= events.length) {
        this._stopScheduler();
        this._playing       = false;
        this._startOffsetMs = 0;
        this._nextEventIdx  = 0;
        this._sendPanic();
        if (typeof this._onEnded === 'function') {
          // Defer so the last event's setTimeout has time to fire
          const totalRemainMs = (this._totalMs - currentMs) / this._speed;
          setTimeout(() => this._onEnded(), Math.max(0, totalRemainMs) + 50);
        }
      }
    }, INTERVAL_MS);
  }

  _stopScheduler() {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  _sendPanic() {
    this._port.postMessage({ type: 'panic' });
  }

  /** Restart the scheduler from a new offset (used by seekFraction and speedMultiplier). */
  _restartFrom(offsetMs) {
    this._stopScheduler();
    this._startOffsetMs  = offsetMs;
    this._startAudioTime = this._audioCtx.currentTime;
    this._syncEventIndex();
    this._startScheduler();
  }

  /**
   * Set _nextEventIdx to the first event at or after _startOffsetMs.
   */
  _syncEventIndex() {
    const events = this._midi.events;
    let idx = 0;
    while (idx < events.length) {
      const evMs = this._tickToMs(events[idx].absTick);
      if (evMs >= this._startOffsetMs) break;
      idx++;
    }
    this._nextEventIdx = idx;
  }

  // ------------------------------------------------------------------
  // Tempo / tick conversion
  // ------------------------------------------------------------------

  /**
   * Build an array of tempo segments:
   * [{ startTick, startMs, tempoUs }, ...]
   * Sorted by startTick ascending.
   */
  _buildTempoSegments() {
    const ppqn   = this._midi.ppqn;
    const events = this._midi.events;

    const segments = [{ startTick: 0, startMs: 0, tempoUs: this._midi.initialTempo }];

    for (const ev of events) {
      if (!ev.isTempo) continue;
      const last   = segments[segments.length - 1];
      const deltaTicks = ev.absTick - last.startTick;
      const deltaMs    = (deltaTicks / ppqn) * (last.tempoUs / 1000);
      segments.push({
        startTick: ev.absTick,
        startMs:   last.startMs + deltaMs,
        tempoUs:   ev.tempoUs,
      });
    }

    return segments;
  }

  /**
   * Convert an absolute tick value to milliseconds from tick 0,
   * accounting for all tempo changes and the current speed multiplier.
   * @param {number} tick
   * @returns {number} milliseconds
   */
  _tickToMs(tick) {
    const ppqn     = this._midi.ppqn;
    const segments = this._tempoSegments;

    // Find the last segment whose startTick <= tick
    let seg = segments[0];
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].startTick > tick) break;
      seg = segments[i];
    }

    const deltaTicks = tick - seg.startTick;
    const ms = seg.startMs + (deltaTicks / ppqn) * (seg.tempoUs / 1000);
    // Apply speed: higher speed → events happen sooner in wall-clock ms
    // We keep _tickToMs in "MIDI-speed ms" (speed=1).
    // Speed scaling is applied in the scheduler when computing wall-clock times.
    return ms;
  }

  /** The absTick of the last event in the file. */
  _lastTick() {
    const events = this._midi.events;
    if (events.length === 0) return 0;
    return events[events.length - 1].absTick;
  }
}
