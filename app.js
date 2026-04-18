/* ============================================================
   IUC Jukebox — app.js  (MT-32 WASM real-time synthesis)
   Pure vanilla JS, no frameworks, no imports.
   ============================================================ */

(function () {
  "use strict";

  /* ── Constants ──────────────────────────────────────────── */
  const TRACKS_URL     = "tracks.json";
  const SPD_MIN        = 0.25;
  const SPD_MAX        = 2.00;
  const SPD_STEP       = 0.05;
  const VOL_DEFAULT    = 0.80;
  const PREV_RESTART_S = 3;
  const VIS_BARS       = 36;
  const VIS_FFT        = 2048;
  const VIS_SMOOTH     = 0.80;
  const VIS_FREQ_LOW   = 80;
  const VIS_FREQ_HIGH  = 18000;
  const PROGRESS_HZ    = 10;

  const COL_TEAL  = "#00CDAA";
  const COL_AMBER = "#FFBE32";
  const COL_BG    = "#0C0A16";

  /* ── State ──────────────────────────────────────────────── */
  let tracks        = [];
  let currentIndex  = -1;
  let selectedIndex = -1;
  let isPlaying     = false;
  let loopOn        = false;
  let shuffleOn     = false;
  let playbackRate  = 1.0;

  /* MT-32 synthesis */
  let audioCtx    = null;
  let mt32Node    = null;
  let gainNode    = null;
  let analyser    = null;
  let freqData    = null;
  let synthReady  = false;
  let synthPromise= null;
  let scheduler   = null;
  let pendingPlay = null;

  /* Visualizer peak state */
  let peakValues = new Float32Array(VIS_BARS).fill(0);
  let peakVels   = new Float32Array(VIS_BARS).fill(0);

  let isDragging = false;

  /* ── DOM refs ───────────────────────────────────────────── */
  const elNowPlaying    = document.getElementById("now-playing");
  const elProgressTrack = document.getElementById("progress-track");
  const elProgressFill  = document.getElementById("progress-fill");
  const elProgressThumb = document.getElementById("progress-thumb");
  const elProgressTime  = document.getElementById("progress-time");
  const elTracklist     = document.getElementById("tracklist");
  const elBtnPlay       = document.getElementById("btn-play");
  const elBtnStop       = document.getElementById("btn-stop");
  const elBtnPrev       = document.getElementById("btn-prev");
  const elBtnNext       = document.getElementById("btn-next");
  const elBtnLoop       = document.getElementById("btn-loop");
  const elBtnShuf       = document.getElementById("btn-shuf");
  const elVolSlider     = document.getElementById("vol-slider");
  const elSpdLabel      = document.getElementById("spd-label");
  const elBtnSpdUp      = document.getElementById("btn-spd-up");
  const elBtnSpdDown    = document.getElementById("btn-spd-down");
  const elBtnInfo       = document.getElementById("btn-info");
  const elInfoOverlay   = document.getElementById("info-overlay");
  const elInfoClose     = document.getElementById("info-close");
  const elCanvas        = document.getElementById("visualizer");
  const ctx2d           = elCanvas.getContext("2d");

  /* ── Helpers ────────────────────────────────────────────── */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    return Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function freqToBin(freq, fftSize, sr) {
    return Math.round((freq / (sr / 2)) * (fftSize / 2));
  }

  function buildFreqEdges(n, sr) {
    const lo = Math.log10(VIS_FREQ_LOW), hi = Math.log10(VIS_FREQ_HIGH);
    const e = [];
    for (let i = 0; i <= n; i++)
      e.push(freqToBin(Math.pow(10, lo + (hi - lo) * i / n), VIS_FFT, sr));
    return e;
  }

  /* ── MT-32 / AudioContext initialisation ────────────────── */
  function ensureAudioContext() {
    if (synthReady) return Promise.resolve();
    if (synthPromise) return synthPromise;
    synthPromise = _initSynth().catch(err => {
      console.error("MT-32 init failed:", err);
      elNowPlaying.textContent = "⚠ " + err.message;
      synthPromise = null;   // allow retry
    });
    return synthPromise;
  }

  async function _initSynth() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();

    elNowPlaying.textContent = "Downloading MT-32 synthesizer… (first visit ~5 s)";

    /* Fetch all assets in parallel */
    const [jsText, wasmBuf, ctrlRom, pcmRom, workletText] = await Promise.all([
      fetch("build/mt32emu.js").then(r => {
        if (!r.ok) throw new Error("mt32emu.js not built yet — trigger the GitHub Actions workflow");
        return r.text();
      }),
      fetch("build/mt32emu.wasm").then(r => r.arrayBuffer()),
      fetch("roms/cm32l_ctrl_1_02.rom").then(r => r.arrayBuffer()),
      fetch("roms/cm32l_pcm.rom").then(r => r.arrayBuffer()),
      fetch("mt32-worklet.js").then(r => r.text()),
    ]);

    /* Combine Emscripten module + worklet processor into a single Blob */
    const blob    = new Blob([jsText, "\n", workletText], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    /* Build audio graph: worklet → analyser → gain → output */
    mt32Node = new AudioWorkletNode(audioCtx, "mt32-processor", {
      outputChannelCount: [2],
    });
    gainNode = audioCtx.createGain();
    gainNode.gain.value = clamp(parseFloat(elVolSlider.value) / 100, 0, 1);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize               = VIS_FFT;
    analyser.smoothingTimeConstant = VIS_SMOOTH;
    freqData = new Uint8Array(analyser.frequencyBinCount);

    mt32Node.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    /* Handshake: send ROMs + WASM to worklet, wait for 'ready' */
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MT-32 init timed out — check browser console")), 45000);
      mt32Node.port.onmessage = ({ data }) => {
        if (data.type === "ready")  { clearTimeout(timer); resolve(data.sampleRate); }
        if (data.type === "error")  { clearTimeout(timer); reject(new Error(data.message)); }
      };
      mt32Node.port.postMessage(
        { type: "init", wasmBinary: wasmBuf, ctrlRom, pcmRom },
        [wasmBuf, ctrlRom, pcmRom]
      );
    });

    mt32Node.port.onmessage = null;
    synthReady = true;

    elNowPlaying.textContent = "— stopped —";

    /* Execute any play that was queued before synth was ready */
    if (pendingPlay !== null) {
      const idx = pendingPlay;
      pendingPlay = null;
      playTrack(idx);
    }
  }

  /* ── Track loading ───────────────────────────────────────── */
  async function fetchAndParseMidi(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("MIDI not found: " + url);
    return MidiParser.parse(await resp.arrayBuffer());
  }

  /* ── Playback engine ─────────────────────────────────────── */
  function _stopScheduler() {
    if (scheduler) { scheduler.stop(); scheduler = null; }
  }

  async function playTrack(index) {
    if (index < 0 || index >= tracks.length) return;

    if (!synthReady) {
      /* Queue the play; ensureAudioContext will execute it once ready */
      pendingPlay = index;
      currentIndex  = index;
      selectedIndex = index;
      updateNowPlaying();
      updateTracklistHighlight();
      scrollTrackIntoView(index);
      ensureAudioContext();
      return;
    }

    if (audioCtx.state === "suspended") await audioCtx.resume();

    _stopScheduler();
    currentIndex  = index;
    selectedIndex = index;
    updateNowPlaying();
    updateTracklistHighlight();
    scrollTrackIntoView(index);

    let parsed;
    try {
      parsed = await fetchAndParseMidi(tracks[index].midi);
    } catch (err) {
      console.error(err);
      elNowPlaying.textContent = "⚠ " + err.message;
      isPlaying = false;
      updatePlayButton();
      return;
    }

    scheduler = new MidiScheduler(parsed, mt32Node.port);
    scheduler.speedMultiplier = playbackRate;
    scheduler.onEnded = _onTrackEnded;
    scheduler.play(audioCtx);
    isPlaying = true;
    updatePlayButton();
  }

  function _onTrackEnded() {
    isPlaying = false;
    updatePlayButton();
    if (loopOn) {
      playTrack(currentIndex);
    } else if (shuffleOn) {
      playTrack(_shuffleNext());
    } else if (currentIndex < tracks.length - 1) {
      playTrack(currentIndex + 1);
    } else {
      _stopScheduler();
      updateNowPlaying();
      updateProgress();
    }
  }

  function togglePlay() {
    if (!synthReady || !scheduler || currentIndex < 0) {
      playTrack(selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }
    if (isPlaying) {
      scheduler.pause();
      isPlaying = false;
    } else {
      if (audioCtx.state === "suspended") audioCtx.resume();
      scheduler.play(audioCtx);
      isPlaying = true;
    }
    updatePlayButton();
  }

  function stopPlayback() {
    _stopScheduler();
    isPlaying   = false;
    currentIndex = -1;
    updatePlayButton();
    updateNowPlaying();
    updateProgress();
  }

  function prevTrack() {
    if (!tracks.length) return;
    if (scheduler && scheduler.currentTimeSec > PREV_RESTART_S) {
      playTrack(currentIndex);
      return;
    }
    const i = currentIndex > 0 ? currentIndex - 1 : tracks.length - 1;
    playTrack(i);
  }

  function nextTrack() {
    if (!tracks.length) return;
    playTrack(shuffleOn ? _shuffleNext() : (currentIndex + 1) % tracks.length);
  }

  function _shuffleNext() {
    if (tracks.length === 1) return 0;
    let c, t = 0;
    do { c = Math.floor(Math.random() * tracks.length); t++; } while (c === currentIndex && t < 20);
    return c;
  }

  /* ── UI state updates ───────────────────────────────────── */
  function updatePlayButton() {
    if (isPlaying) {
      elBtnPlay.innerHTML = "&#9646;&#9646;&nbsp;PAUSE";
      elBtnPlay.classList.remove("paused");
      elBtnPlay.setAttribute("aria-label", "Pause");
    } else {
      elBtnPlay.innerHTML = "&#9654;&nbsp;PLAY";
      elBtnPlay.classList.add("paused");
      elBtnPlay.setAttribute("aria-label", "Play");
    }
  }

  function updateNowPlaying() {
    if (synthPromise && !synthReady) {
      elNowPlaying.textContent = "Loading MT-32 synthesizer…";
      return;
    }
    if (currentIndex >= 0 && currentIndex < tracks.length) {
      const t = tracks[currentIndex];
      elNowPlaying.textContent = t.number + " · " + t.title;
    } else {
      elNowPlaying.textContent = "— stopped —";
    }
  }

  function updateProgress() {
    const cur   = scheduler ? scheduler.currentTimeSec  : 0;
    const total = scheduler ? scheduler.totalTimeSec     : 0;
    const pct   = scheduler ? scheduler.playbackFraction : 0;

    elProgressFill.style.width = (pct * 100) + "%";
    elProgressThumb.style.left = (pct * 100) + "%";
    elProgressTrack.setAttribute("aria-valuenow", Math.round(pct * 100));
    elProgressTime.textContent  = fmtTime(cur) + " / " + fmtTime(total);
  }

  function updateLoopButton() {
    elBtnLoop.classList.toggle("active", loopOn);
    elBtnLoop.setAttribute("aria-pressed", String(loopOn));
  }

  function updateShufButton() {
    elBtnShuf.classList.toggle("active", shuffleOn);
    elBtnShuf.setAttribute("aria-pressed", String(shuffleOn));
  }

  function updateSpeedLabel() {
    elSpdLabel.textContent = Math.round(playbackRate * 100) + "%";
  }

  function setSpeed(r) {
    playbackRate = clamp(r, SPD_MIN, SPD_MAX);
    if (scheduler) scheduler.speedMultiplier = playbackRate;
    updateSpeedLabel();
  }

  function setVolume(v) {
    if (gainNode) gainNode.gain.value = clamp(v / 100, 0, 1);
  }

  /* ── Progress bar interaction ───────────────────────────── */
  function seekFrac(frac) {
    if (scheduler) scheduler.seekFraction(clamp(frac, 0, 1));
    updateProgress();
  }

  function fracFromEvent(e) {
    const rect = elProgressTrack.getBoundingClientRect();
    const x    = e.touches ? e.touches[0].clientX : e.clientX;
    return clamp((x - rect.left) / rect.width, 0, 1);
  }

  elProgressTrack.addEventListener("mousedown",  e => { e.preventDefault(); isDragging = true; seekFrac(fracFromEvent(e)); });
  elProgressTrack.addEventListener("touchstart", e => { isDragging = true; seekFrac(fracFromEvent(e)); }, { passive: true });
  document.addEventListener("mousemove",  e => { if (isDragging) seekFrac(fracFromEvent(e)); });
  document.addEventListener("touchmove",  e => { if (isDragging) seekFrac(fracFromEvent(e)); }, { passive: true });
  document.addEventListener("mouseup",    () => { isDragging = false; });
  document.addEventListener("touchend",   () => { isDragging = false; });

  elProgressTrack.addEventListener("keydown", e => {
    if (!scheduler) return;
    const tot = scheduler.totalTimeSec;
    if (!tot) return;
    let d = 0;
    if (e.key === "ArrowRight") d =  5;
    if (e.key === "ArrowLeft")  d = -5;
    if (d) { e.preventDefault(); scheduler.seekFraction(clamp((scheduler.currentTimeSec + d) / tot, 0, 1)); }
  });

  /* ── Transport buttons ──────────────────────────────────── */
  elBtnPlay.addEventListener("click", togglePlay);
  elBtnStop.addEventListener("click", stopPlayback);
  elBtnPrev.addEventListener("click", prevTrack);
  elBtnNext.addEventListener("click", nextTrack);
  elBtnLoop.addEventListener("click", () => { loopOn    = !loopOn;    updateLoopButton(); });
  elBtnShuf.addEventListener("click", () => { shuffleOn = !shuffleOn; updateShufButton(); });

  /* ── Volume & speed controls ────────────────────────────── */
  elVolSlider.addEventListener("input",   function () { setVolume(+this.value); });
  elBtnSpdUp.addEventListener  ("click",  () => setSpeed(Math.round((playbackRate + SPD_STEP) * 100) / 100));
  elBtnSpdDown.addEventListener("click",  () => setSpeed(Math.round((playbackRate - SPD_STEP) * 100) / 100));
  elSpdLabel.addEventListener  ("dblclick", () => setSpeed(1.0));

  /* ── Info modal ─────────────────────────────────────────── */
  function closeInfo() { elInfoOverlay.hidden = true; elBtnInfo.focus(); }
  elBtnInfo.addEventListener("click",  () => { elInfoOverlay.hidden = false; elInfoClose.focus(); });
  elInfoClose.addEventListener("click", closeInfo);
  elInfoOverlay.addEventListener("click", e => { if (e.target === elInfoOverlay) closeInfo(); });

  /* ── Keyboard shortcuts ─────────────────────────────────── */
  document.addEventListener("keydown", e => {
    const tag = document.activeElement.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (!elInfoOverlay.hidden) { if (e.key === "Escape") closeInfo(); return; }

    switch (e.key) {
      case " ":
        e.preventDefault(); togglePlay(); break;
      case "ArrowLeft":
        if (document.activeElement !== elProgressTrack) { e.preventDefault(); prevTrack(); }
        break;
      case "ArrowRight":
        if (document.activeElement !== elProgressTrack) { e.preventDefault(); nextTrack(); }
        break;
      case "ArrowUp":
        e.preventDefault();
        { const v = Math.min(100, +elVolSlider.value + 5); elVolSlider.value = v; setVolume(v); }
        break;
      case "ArrowDown":
        e.preventDefault();
        { const v = Math.max(0, +elVolSlider.value - 5); elVolSlider.value = v; setVolume(v); }
        break;
      case "[": setSpeed(Math.round((playbackRate - 0.05) * 100) / 100); break;
      case "]": setSpeed(Math.round((playbackRate + 0.05) * 100) / 100); break;
      case "Escape": closeInfo(); break;
    }
  });

  /* ── Progress polling ────────────────────────────────────── */
  setInterval(() => { if (!isDragging) updateProgress(); }, 1000 / PROGRESS_HZ);

  /* ── Track list rendering ───────────────────────────────── */
  function renderTracklist() {
    elTracklist.innerHTML = "";
    tracks.forEach((track, i) => {
      const li = document.createElement("li");
      li.className = "track-row";
      li.setAttribute("tabindex", "0");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.dataset.index = i;

      const ns = document.createElement("span");
      ns.className = "track-num";
      ns.textContent = track.number;

      const ts = document.createElement("span");
      ts.className = "track-title";
      ts.textContent = track.title;

      li.appendChild(ns);
      li.appendChild(ts);
      li.addEventListener("click",    () => setSelected(i));
      li.addEventListener("dblclick", () => playTrack(i));
      li.addEventListener("keydown",  e => { if (e.key === "Enter") playTrack(i); });
      elTracklist.appendChild(li);
    });
  }

  function updateTracklistHighlight() {
    elTracklist.querySelectorAll(".track-row").forEach((row, i) => {
      row.classList.toggle("playing",  i === currentIndex);
      row.classList.toggle("selected", i === selectedIndex && i !== currentIndex);
      row.setAttribute("aria-selected", i === currentIndex ? "true" : "false");
    });
  }

  function scrollTrackIntoView(i) {
    const rows = elTracklist.querySelectorAll(".track-row");
    if (rows[i]) rows[i].scrollIntoView({ block: "nearest" });
  }

  function setSelected(i) { selectedIndex = i; updateTracklistHighlight(); }

  /* ── Visualizer ─────────────────────────────────────────── */
  function resizeCanvas() {
    const w = elCanvas.parentElement;
    elCanvas.width  = w.clientWidth;
    elCanvas.height = w.clientHeight;
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  function drawVisualizer() {
    requestAnimationFrame(drawVisualizer);
    const W = elCanvas.width, H = elCanvas.height;

    ctx2d.fillStyle = COL_BG;
    ctx2d.fillRect(0, 0, W, H);

    const sr    = audioCtx ? audioCtx.sampleRate : 44100;
    const edges = buildFreqEdges(VIS_BARS, sr);

    if (analyser && freqData && isPlaying) analyser.getByteFrequencyData(freqData);

    const step = W / VIS_BARS;
    const pad  = Math.max(1, Math.floor(step * 0.18));
    const bw   = Math.max(2, Math.floor(step) - pad);

    for (let i = 0; i < VIS_BARS; i++) {
      let mag = 0;
      if (analyser && freqData) {
        const lo = Math.max(0, edges[i]), hi = Math.min(freqData.length - 1, edges[i + 1]);
        let s = 0, c = 0;
        for (let b = lo; b <= hi; b++) { s += freqData[b]; c++; }
        mag = c > 0 ? s / c / 255 : 0;
      }

      const x = Math.round(i * step + pad * 0.5);
      const h = Math.max(2, Math.round(mag * (H - 8)));

      const g = ctx2d.createLinearGradient(0, H, 0, H - h);
      g.addColorStop(0,   "#00CDAA");
      g.addColorStop(0.5, "#5060FF");
      g.addColorStop(1,   "#A064FF");
      ctx2d.fillStyle = g;
      ctx2d.fillRect(x, H - h, bw, h);

      if (mag > peakValues[i]) { peakValues[i] = mag; peakVels[i] = 0; }
      else { peakVels[i] += 0.0025; peakValues[i] = Math.max(0, peakValues[i] - peakVels[i]); }

      ctx2d.fillStyle = COL_AMBER;
      ctx2d.fillRect(x, H - Math.round(peakValues[i] * (H - 8)) - 2, bw, 2);
    }

    if (!isPlaying) { ctx2d.fillStyle = COL_TEAL; ctx2d.fillRect(0, H - 2, W, 2); }

    ctx2d.fillStyle = "rgba(0,0,0,0.18)";
    for (let y = 0; y < H; y += 4) ctx2d.fillRect(0, y, W, 1);
  }

  drawVisualizer();

  /* ── Boot ────────────────────────────────────────────────── */
  fetch(TRACKS_URL)
    .then(r => { if (!r.ok) throw new Error("tracks.json not found"); return r.json(); })
    .then(data => { tracks = data; renderTracklist(); setSelected(0); })
    .catch(err => { console.error(err); elNowPlaying.textContent = "Error: " + err.message; });

  updatePlayButton();
  updateLoopButton();
  updateShufButton();
  updateSpeedLabel();
  updateProgress();

})();
