// midi-parser.js
// Browser global — no module syntax.
// Usage: const parsed = MidiParser.parse(arrayBuffer);

class MidiParser {
  /**
   * Parse a Standard MIDI File.
   * @param {ArrayBuffer} arrayBuffer
   * @returns {{
   *   format: number,
   *   ppqn: number,
   *   initialTempo: number,
   *   events: Array<{
   *     absTick: number,
   *     isTempo: boolean,
   *     tempoUs: number,
   *     isSysEx: boolean,
   *     sysExData: Uint8Array,
   *     msg: number
   *   }>
   * }}
   */
  static parse(arrayBuffer) {
    const data = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);

    // ---- read header chunk ------------------------------------------------
    const headerTag = MidiParser._readTag(bytes, 0);
    if (headerTag !== 'MThd') throw new Error('Not a MIDI file (missing MThd)');
    const headerLen = data.getUint32(4);
    if (headerLen < 6) throw new Error('Invalid MThd length');

    const format    = data.getUint16(8);
    const numTracks = data.getUint16(10);
    const timingWord = data.getUint16(12);

    if (timingWord & 0x8000) {
      throw new Error('SMPTE timing not supported');
    }
    const ppqn = timingWord;

    // ---- read tracks ------------------------------------------------------
    let pos = 8 + headerLen;           // skip past header chunk data
    const allEvents = [];

    for (let t = 0; t < numTracks; t++) {
      if (pos + 8 > bytes.length) break;

      const trackTag = MidiParser._readTag(bytes, pos);
      if (trackTag !== 'MTrk') {
        // skip unknown chunk
        const unknownLen = data.getUint32(pos + 4);
        pos += 8 + unknownLen;
        continue;
      }

      const trackLen = data.getUint32(pos + 4);
      pos += 8;
      const trackEnd = pos + trackLen;

      const trackEvents = MidiParser._parseTrack(bytes, pos, trackEnd);
      for (const ev of trackEvents) allEvents.push(ev);

      pos = trackEnd;
    }

    // ---- sort all events by absTick --------------------------------------
    allEvents.sort((a, b) => a.absTick - b.absTick);

    // ---- determine initialTempo ------------------------------------------
    let initialTempo = 500000;
    for (const ev of allEvents) {
      if (ev.isTempo) {
        initialTempo = ev.tempoUs;
        break;
      }
    }

    // ---- filter zero-msg non-special events ------------------------------
    const events = allEvents.filter(
      (ev) => ev.isTempo || ev.isSysEx || ev.msg !== 0
    );

    return { format, ppqn, initialTempo, events };
  }

  // -----------------------------------------------------------------------

  static _readTag(bytes, offset) {
    return String.fromCharCode(
      bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
    );
  }

  /**
   * Read a variable-length quantity.
   * @returns {{ value: number, bytesRead: number }}
   */
  static _readVLQ(bytes, offset, end) {
    let value = 0;
    let bytesRead = 0;
    while (offset < end) {
      const b = bytes[offset++];
      bytesRead++;
      value = (value << 7) | (b & 0x7F);
      if (!(b & 0x80)) break;
    }
    return { value, bytesRead };
  }

  /**
   * Parse a single MTrk chunk, returning an array of events with absTick set.
   */
  static _parseTrack(bytes, start, end) {
    const events = [];
    let pos = start;
    let absTick = 0;
    let runningStatus = 0;

    while (pos < end) {
      // delta time
      const delta = MidiParser._readVLQ(bytes, pos, end);
      pos += delta.bytesRead;
      absTick += delta.value;

      if (pos >= end) break;

      let statusByte = bytes[pos];

      // ---- Meta event: 0xFF ------------------------------------------
      if (statusByte === 0xFF) {
        pos++;
        if (pos >= end) break;
        const metaType = bytes[pos++];
        const lenVlq = MidiParser._readVLQ(bytes, pos, end);
        pos += lenVlq.bytesRead;
        const metaLen = lenVlq.value;

        if (metaType === 0x51 && metaLen >= 3) {
          // Set Tempo
          const tempoUs = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
          events.push({
            absTick,
            isTempo: true,
            tempoUs,
            isSysEx: false,
            sysExData: null,
            msg: 0,
          });
        }
        // skip meta data bytes (including non-tempo metas)
        pos += metaLen;
        runningStatus = 0;  // meta events cancel running status
        continue;
      }

      // ---- SysEx: 0xF0 or 0xF7 --------------------------------------
      if (statusByte === 0xF0 || statusByte === 0xF7) {
        pos++;
        const lenVlq = MidiParser._readVLQ(bytes, pos, end);
        pos += lenVlq.bytesRead;
        const sysexLen = lenVlq.value;

        // Build sysExData including the leading F0/F7 byte
        const sysExData = new Uint8Array(sysexLen + 1);
        sysExData[0] = statusByte;
        for (let i = 0; i < sysexLen; i++) {
          sysExData[i + 1] = bytes[pos + i];
        }
        pos += sysexLen;

        events.push({
          absTick,
          isTempo: false,
          tempoUs: 0,
          isSysEx: true,
          sysExData,
          msg: 0,
        });
        runningStatus = 0;  // sysex cancels running status
        continue;
      }

      // ---- Channel message -------------------------------------------
      // Determine status, applying running status if needed
      let status;
      if (statusByte & 0x80) {
        // New status byte
        status = statusByte;
        runningStatus = statusByte;
        pos++;
      } else {
        // Data byte — use running status
        if (runningStatus === 0) {
          // Corrupt data; skip byte
          pos++;
          continue;
        }
        status = runningStatus;
        // do NOT advance pos — statusByte is actually data1
      }

      const statusType = status & 0xF0;

      // Determine number of data bytes
      let dataLen;
      switch (statusType) {
        case 0xC0: // Program Change
        case 0xD0: // Channel Pressure
          dataLen = 1;
          break;
        case 0xF0: // System messages that slipped through (e.g. 0xF2, 0xF3)
          dataLen = (status === 0xF2) ? 2 : (status === 0xF3) ? 1 : 0;
          break;
        default:   // Note On/Off, Aftertouch, CC, Pitch Bend
          dataLen = 2;
          break;
      }

      let data1 = 0;
      let data2 = 0;

      if (dataLen >= 1) {
        if (pos >= end) break;
        data1 = bytes[pos++];
      }
      if (dataLen >= 2) {
        if (pos >= end) break;
        data2 = bytes[pos++];
      }

      // Pack into uint32: status | data1<<8 | data2<<16
      const msg = (status & 0xFF) | ((data1 & 0xFF) << 8) | ((data2 & 0xFF) << 16);

      events.push({
        absTick,
        isTempo: false,
        tempoUs: 0,
        isSysEx: false,
        sysExData: null,
        msg,
      });
    }

    return events;
  }
}
