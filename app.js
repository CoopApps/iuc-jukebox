/* ============================================================
   IUC Jukebox — app.js
   Pure vanilla JS, no frameworks, no imports.
   ============================================================ */

(function () {
  "use strict";

  /* ----------------------------------------------------------
     Constants
  ---------------------------------------------------------- */
  const TRACKS_URL     = "tracks.json";
  const SPD_MIN        = 0.25;
  const SPD_MAX        = 2.00;
  const SPD_STEP       = 0.05;
  const VOL_DEFAULT    = 0.80;
  const PREV_RESTART_S = 3;       // if >3s in, prev = restart
  const VIS_BARS       = 36;
  const VIS_FFT        = 1024;
  const VIS_SMOOTH     = 0.80;
  const VIS_FREQ_LOW   = 80;
  const VIS_FREQ_HIGH  = 18000;
  const PROGRESS_HZ    = 10;      // updates per second

  const COL_TEAL   = "#00CDAA";
  const COL_PURPLE = "#A064FF";
  const COL_AMBER  = "#FFBE32";
  const COL_BG     = "#0C0A16";
  const COL_DIM    = "#6E6982";

  /* ----------------------------------------------------------
     State
  ---------------------------------------------------------- */
  let tracks        = [];
  let currentIndex  = -1;
  let selectedIndex = -1;
  let isPlaying     = false;
  let loopOn        = false;
  let shuffleOn     = false;
  let playbackRate  = 1.0;
  let shuffleHistory = [];

  /* Web Audio */
  let audioCtx      = null;
  let sourceNode    = null;
  let analyser      = null;
  let freqData      = null;
  let audioReady    = false;

  /* Peak markers per bar */
  let peakValues = new Float32Array(VIS_BARS).fill(0);
  let peakVels   = new Float32Array(VIS_BARS).fill(0);

  /* Progress drag state */
  let isDragging = false;

  /* Animation frame handle */
  let rafHandle = null;

  /* Progress interval handle */
  let progressInterval = null;

  /* ----------------------------------------------------------
     DOM refs
  ---------------------------------------------------------- */
  const audio         = new Audio();
  audio.volume        = VOL_DEFAULT;
  audio.preload       = "metadata";

  const elNowPlaying  = document.getElementById("now-playing");
  const elProgressTrack = document.getElementById("progress-track");
  const elProgressFill  = document.getElementById("progress-fill");
  const elProgressThumb = document.getElementById("progress-thumb");
  const elProgressTime  = document.getElementById("progress-time");
  const elTracklist   = document.getElementById("tracklist");
  const elBtnPlay     = document.getElementById("btn-play");
  const elBtnStop     = document.getElementById("btn-stop");
  const elBtnPrev     = document.getElementById("btn-prev");
  const elBtnNext     = document.getElementById("btn-next");
  const elBtnLoop     = document.getElementById("btn-loop");
  const elBtnShuf     = document.getElementById("btn-shuf");
  const elVolSlider   = document.getElementById("vol-slider");
  const elSpdLabel    = document.getElementById("spd-label");
  const elBtnSpdUp    = document.getElementById("btn-spd-up");
  const elBtnSpdDown  = document.getElementById("btn-spd-down");
  const elBtnInfo     = document.getElementById("btn-info");
  const elInfoOverlay = document.getElementById("info-overlay");
  const elInfoClose   = document.getElementById("info-close");
  const elCanvas      = document.getElementById("visualizer");
  const ctx2d         = elCanvas.getContext("2d");

  /* ----------------------------------------------------------
     Utility helpers
  ---------------------------------------------------------- */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function clamp(val, lo, hi) {
    return Math.max(lo, Math.min(hi, val));
  }

  /* Logarithmic frequency to FFT bin mapping */
  function freqToBin(freq, fftSize, sampleRate) {
    const nyquist = sampleRate / 2;
    return Math.round((freq / nyquist) * (fftSize / 2));
  }

  /* Build logarithmically-spaced frequency edges for bars */
  function buildFreqEdges(numBars, sampleRate) {
    const edges = [];
    const logLow  = Math.log10(VIS_FREQ_LOW);
    const logHigh = Math.log10(VIS_FREQ_HIGH);
    for (let i = 0; i <= numBars; i++) {
      const f = Math.pow(10, logLow + (logHigh - logLow) * (i / numBars));
      edges.push(freqToBin(f, VIS_FFT, sampleRate));
    }
    return edges;
  }

  /* ----------------------------------------------------------
     Web Audio init (lazy — called on first user interaction)
  ---------------------------------------------------------- */
  function ensureAudioContext() {
    if (audioReady) return;
    audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode  = audioCtx.createMediaElementSource(audio);
    analyser    = audioCtx.createAnalyser();
    analyser.fftSize               = VIS_FFT;
    analyser.smoothingTimeConstant = VIS_SMOOTH;
    freqData    = new Uint8Array(analyser.frequencyBinCount);
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    audioReady  = true;
  }

  function resumeAudioContext() {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  }

  /* ----------------------------------------------------------
     Track list rendering
  ---------------------------------------------------------- */
  function renderTracklist() {
    elTracklist.innerHTML = "";
    tracks.forEach(function (track, i) {
      const li = document.createElement("li");
      li.className = "track-row";
      li.setAttribute("tabindex", "0");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.dataset.index = i;

      const numSpan = document.createElement("span");
      numSpan.className = "track-num";
      numSpan.textContent = track.number;

      const titleSpan = document.createElement("span");
      titleSpan.className = "track-title";
      titleSpan.textContent = track.title;

      li.appendChild(numSpan);
      li.appendChild(titleSpan);

      /* Single click → select */
      li.addEventListener("click", function () {
        setSelected(i);
      });

      /* Double-click → play */
      li.addEventListener("dblclick", function () {
        playTrack(i);
      });

      /* Enter key → play */
      li.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          playTrack(i);
        }
      });

      elTracklist.appendChild(li);
    });
  }

  function updateTracklistHighlight() {
    const rows = elTracklist.querySelectorAll(".track-row");
    rows.forEach(function (row, i) {
      row.classList.toggle("playing",  i === currentIndex);
      row.classList.toggle("selected", i === selectedIndex && i !== currentIndex);
      row.setAttribute("aria-selected", i === currentIndex ? "true" : "false");
    });
  }

  function scrollTrackIntoView(index) {
    const rows = elTracklist.querySelectorAll(".track-row");
    if (rows[index]) {
      rows[index].scrollIntoView({ block: "nearest" });
    }
  }

  /* ----------------------------------------------------------
     Selection
  ---------------------------------------------------------- */
  function setSelected(index) {
    selectedIndex = index;
    updateTracklistHighlight();
  }

  /* ----------------------------------------------------------
     Playback engine
  ---------------------------------------------------------- */
  function loadTrack(index) {
    if (index < 0 || index >= tracks.length) return;
    currentIndex = index;
    selectedIndex = index;
    audio.src = tracks[index].file;
    audio.load();
    audio.playbackRate = playbackRate;
    updateNowPlaying();
    updateTracklistHighlight();
    scrollTrackIntoView(index);
  }

  function playTrack(index) {
    ensureAudioContext();
    resumeAudioContext();
    loadTrack(index);
    audio.play().then(function () {
      isPlaying = true;
      updatePlayButton();
    }).catch(function (err) {
      console.warn("Playback error:", err);
    });
  }

  function togglePlay() {
    ensureAudioContext();
    resumeAudioContext();

    if (currentIndex < 0) {
      /* Nothing loaded — start first track */
      playTrack(selectedIndex >= 0 ? selectedIndex : 0);
      return;
    }

    if (isPlaying) {
      audio.pause();
      isPlaying = false;
    } else {
      audio.play().then(function () {
        isPlaying = true;
        updatePlayButton();
      }).catch(function (err) {
        console.warn("Playback error:", err);
      });
    }
    updatePlayButton();
  }

  function stopPlayback() {
    audio.pause();
    audio.currentTime = 0;
    isPlaying = false;
    updatePlayButton();
    updateProgress();
  }

  function prevTrack() {
    ensureAudioContext();
    resumeAudioContext();

    if (currentIndex < 0) {
      playTrack(tracks.length - 1);
      return;
    }
    /* If >3s in, restart current track */
    if (audio.currentTime > PREV_RESTART_S) {
      audio.currentTime = 0;
      if (!isPlaying) {
        audio.play().then(function () {
          isPlaying = true;
          updatePlayButton();
        });
      }
      return;
    }
    const newIndex = currentIndex > 0 ? currentIndex - 1 : tracks.length - 1;
    playTrack(newIndex);
  }

  function nextTrack() {
    ensureAudioContext();
    resumeAudioContext();

    if (tracks.length === 0) return;

    if (shuffleOn) {
      playTrack(getShuffleNext());
    } else {
      const newIndex = (currentIndex + 1) % tracks.length;
      playTrack(newIndex);
    }
  }

  function getShuffleNext() {
    if (tracks.length === 1) return 0;
    /* Avoid immediate repeat */
    let candidate;
    let attempts = 0;
    do {
      candidate = Math.floor(Math.random() * tracks.length);
      attempts++;
    } while (candidate === currentIndex && attempts < 20);
    return candidate;
  }

  /* Auto-advance on track end */
  audio.addEventListener("ended", function () {
    isPlaying = false;
    updatePlayButton();
    if (loopOn) {
      audio.currentTime = 0;
      audio.play().then(function () {
        isPlaying = true;
        updatePlayButton();
      });
    } else if (shuffleOn) {
      playTrack(getShuffleNext());
    } else {
      if (currentIndex < tracks.length - 1) {
        playTrack(currentIndex + 1);
      } else {
        /* End of playlist */
        updateNowPlaying();
        updateProgress();
      }
    }
  });

  audio.addEventListener("play",  function () { isPlaying = true;  updatePlayButton(); });
  audio.addEventListener("pause", function () { isPlaying = false; updatePlayButton(); });
  audio.addEventListener("error", function () {
    /* Graceful error for missing file */
    isPlaying = false;
    updatePlayButton();
  });

  /* ----------------------------------------------------------
     UI state updates
  ---------------------------------------------------------- */
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
    if (currentIndex >= 0 && currentIndex < tracks.length) {
      const t = tracks[currentIndex];
      elNowPlaying.textContent = t.number + " · " + t.title;
    } else {
      elNowPlaying.textContent = "— stopped —";
    }
  }

  function updateProgress() {
    const dur = audio.duration;
    const cur = audio.currentTime;
    const pct = (isFinite(dur) && dur > 0) ? (cur / dur) : 0;

    elProgressFill.style.width = (pct * 100) + "%";
    elProgressThumb.style.left  = (pct * 100) + "%";

    elProgressTrack.setAttribute("aria-valuenow", Math.round(pct * 100));

    const timeStr = fmtTime(cur) + " / " + fmtTime(dur);
    elProgressTime.textContent = timeStr;
  }

  function updateLoopButton() {
    elBtnLoop.classList.toggle("active", loopOn);
    elBtnLoop.setAttribute("aria-pressed", loopOn ? "true" : "false");
  }

  function updateShufButton() {
    elBtnShuf.classList.toggle("active", shuffleOn);
    elBtnShuf.setAttribute("aria-pressed", shuffleOn ? "true" : "false");
  }

  function updateSpeedLabel() {
    elSpdLabel.textContent = Math.round(playbackRate * 100) + "%";
  }

  function setSpeed(rate) {
    playbackRate = clamp(rate, SPD_MIN, SPD_MAX);
    audio.playbackRate = playbackRate;
    updateSpeedLabel();
  }

  function setVolume(val) {
    audio.volume = clamp(val / 100, 0, 1);
  }

  /* ----------------------------------------------------------
     Progress bar interaction
  ---------------------------------------------------------- */
  function seekToFraction(frac) {
    const dur = audio.duration;
    if (!isFinite(dur) || dur <= 0) return;
    audio.currentTime = clamp(frac, 0, 1) * dur;
    updateProgress();
  }

  function fractionFromEvent(e) {
    const rect = elProgressTrack.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  }

  elProgressTrack.addEventListener("mousedown", function (e) {
    e.preventDefault();
    isDragging = true;
    seekToFraction(fractionFromEvent(e));
  });

  elProgressTrack.addEventListener("touchstart", function (e) {
    isDragging = true;
    seekToFraction(fractionFromEvent(e));
  }, { passive: true });

  document.addEventListener("mousemove", function (e) {
    if (isDragging) seekToFraction(fractionFromEvent(e));
  });
  document.addEventListener("touchmove", function (e) {
    if (isDragging) seekToFraction(fractionFromEvent(e));
  }, { passive: true });

  document.addEventListener("mouseup",  function () { isDragging = false; });
  document.addEventListener("touchend", function () { isDragging = false; });

  /* Keyboard seek on focused progress bar */
  elProgressTrack.addEventListener("keydown", function (e) {
    const dur = audio.duration;
    if (!isFinite(dur)) return;
    let delta = 0;
    if (e.key === "ArrowRight") delta =  5;
    if (e.key === "ArrowLeft")  delta = -5;
    if (delta !== 0) {
      e.preventDefault();
      audio.currentTime = clamp(audio.currentTime + delta, 0, dur);
    }
  });

  /* ----------------------------------------------------------
     Transport button wiring
  ---------------------------------------------------------- */
  elBtnPlay.addEventListener("click", togglePlay);
  elBtnStop.addEventListener("click", stopPlayback);
  elBtnPrev.addEventListener("click", prevTrack);
  elBtnNext.addEventListener("click", nextTrack);

  elBtnLoop.addEventListener("click", function () {
    loopOn = !loopOn;
    updateLoopButton();
  });

  elBtnShuf.addEventListener("click", function () {
    shuffleOn = !shuffleOn;
    updateShufButton();
  });

  /* ----------------------------------------------------------
     Volume & speed controls
  ---------------------------------------------------------- */
  elVolSlider.addEventListener("input", function () {
    setVolume(parseInt(this.value, 10));
  });

  elBtnSpdUp.addEventListener("click", function () {
    setSpeed(Math.round((playbackRate + SPD_STEP) * 100) / 100);
  });
  elBtnSpdDown.addEventListener("click", function () {
    setSpeed(Math.round((playbackRate - SPD_STEP) * 100) / 100);
  });

  elSpdLabel.addEventListener("dblclick", function () {
    setSpeed(1.0);
  });

  /* ----------------------------------------------------------
     Info modal
  ---------------------------------------------------------- */
  elBtnInfo.addEventListener("click", function () {
    elInfoOverlay.hidden = false;
    elInfoClose.focus();
  });

  elInfoClose.addEventListener("click", closeInfo);

  elInfoOverlay.addEventListener("click", function (e) {
    if (e.target === elInfoOverlay) closeInfo();
  });

  function closeInfo() {
    elInfoOverlay.hidden = true;
    elBtnInfo.focus();
  }

  /* ----------------------------------------------------------
     Keyboard shortcuts
  ---------------------------------------------------------- */
  document.addEventListener("keydown", function (e) {
    /* Skip if focus is inside a text input or the modal */
    const tag = document.activeElement.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (!elInfoOverlay.hidden) {
      if (e.key === "Escape") closeInfo();
      return;
    }

    switch (e.key) {
      case " ":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        /* Prevent page scroll; but allow if progress bar is focused (handled there) */
        if (document.activeElement !== elProgressTrack) {
          e.preventDefault();
          prevTrack();
        }
        break;
      case "ArrowRight":
        if (document.activeElement !== elProgressTrack) {
          e.preventDefault();
          nextTrack();
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        {
          const newVol = Math.min(100, parseInt(elVolSlider.value, 10) + 5);
          elVolSlider.value = newVol;
          setVolume(newVol);
        }
        break;
      case "ArrowDown":
        e.preventDefault();
        {
          const newVol = Math.max(0, parseInt(elVolSlider.value, 10) - 5);
          elVolSlider.value = newVol;
          setVolume(newVol);
        }
        break;
      case "[":
        setSpeed(Math.round((playbackRate - 0.05) * 100) / 100);
        break;
      case "]":
        setSpeed(Math.round((playbackRate + 0.05) * 100) / 100);
        break;
      case "Escape":
        closeInfo();
        break;
    }
  });

  /* ----------------------------------------------------------
     Progress bar polling
  ---------------------------------------------------------- */
  progressInterval = setInterval(function () {
    if (!isDragging) updateProgress();
  }, 1000 / PROGRESS_HZ);

  /* ----------------------------------------------------------
     Visualizer
  ---------------------------------------------------------- */
  function resizeCanvas() {
    const wrap = elCanvas.parentElement;
    elCanvas.width  = wrap.clientWidth;
    elCanvas.height = wrap.clientHeight;
  }

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  function drawVisualizer() {
    rafHandle = requestAnimationFrame(drawVisualizer);

    const W = elCanvas.width;
    const H = elCanvas.height;

    /* Clear */
    ctx2d.fillStyle = COL_BG;
    ctx2d.fillRect(0, 0, W, H);

    const sampleRate = audioCtx ? audioCtx.sampleRate : 44100;
    const edges = buildFreqEdges(VIS_BARS, sampleRate);

    if (audioReady && analyser) {
      analyser.getByteFrequencyData(freqData);
    }

    const barPad  = Math.max(1, Math.floor(W / VIS_BARS * 0.18));
    const barW    = Math.max(2, Math.floor(W / VIS_BARS) - barPad);
    const barStep = W / VIS_BARS;

    for (let i = 0; i < VIS_BARS; i++) {
      let magnitude = 0;

      if (audioReady && analyser && freqData) {
        const binLo = Math.max(0, edges[i]);
        const binHi = Math.min(freqData.length - 1, edges[i + 1]);
        let sum = 0;
        let count = 0;
        for (let b = binLo; b <= binHi; b++) {
          sum += freqData[b];
          count++;
        }
        magnitude = count > 0 ? sum / count / 255 : 0;
      }

      const x    = Math.round(i * barStep + barPad * 0.5);
      const barH = Math.max(2, Math.round(magnitude * (H - 8)));

      /* Three-stop gradient: teal (bottom) → blue (mid) → purple (top) */
      const grad = ctx2d.createLinearGradient(0, H, 0, H - barH);
      grad.addColorStop(0,    "#00CDAA");
      grad.addColorStop(0.5,  "#5060FF");
      grad.addColorStop(1,    "#A064FF");

      ctx2d.fillStyle = grad;
      ctx2d.fillRect(x, H - barH, barW, barH);

      /* Peak marker with gravity */
      if (magnitude > peakValues[i]) {
        peakValues[i] = magnitude;
        peakVels[i]   = 0;
      } else {
        peakVels[i]   += 0.0025;          /* gravity */
        peakValues[i] -= peakVels[i];
        if (peakValues[i] < 0) peakValues[i] = 0;
      }

      const peakY = H - Math.round(peakValues[i] * (H - 8)) - 2;
      ctx2d.fillStyle = COL_AMBER;
      ctx2d.fillRect(x, peakY, barW, 2);
    }

    /* Flat baseline when not playing */
    if (!isPlaying || !audioReady) {
      ctx2d.fillStyle = COL_TEAL;
      ctx2d.fillRect(0, H - 2, W, 2);
    }

    /* Scanline overlay */
    ctx2d.fillStyle = "rgba(0,0,0,0.18)";
    for (let y = 0; y < H; y += 4) {
      ctx2d.fillRect(0, y, W, 1);
    }
  }

  drawVisualizer();

  /* ----------------------------------------------------------
     Load tracks and initialise
  ---------------------------------------------------------- */
  fetch(TRACKS_URL)
    .then(function (r) {
      if (!r.ok) throw new Error("tracks.json not found");
      return r.json();
    })
    .then(function (data) {
      tracks = data;
      renderTracklist();
      setSelected(0);
    })
    .catch(function (err) {
      console.error("Failed to load tracks.json:", err);
      elNowPlaying.textContent = "Error: could not load tracks.json";
    });

  /* ----------------------------------------------------------
     Initial UI state
  ---------------------------------------------------------- */
  updatePlayButton();
  updateLoopButton();
  updateShufButton();
  updateSpeedLabel();
  updateProgress();

})();
