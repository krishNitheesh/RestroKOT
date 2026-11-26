/**
 * intercom.js — Restaurant Walkie-Talkie Intercom
 * Ultra-low-latency raw PCM voice streaming over WebSocket.
 * No external dependencies.
 */
(function () {
  'use strict';

  /* ── State ────────────────────────────────────────────────────────── */
  let ws = null;
  let micStream = null;
  let recordCtx = null;
  let recordProcessor = null;
  let playbackCtx = null;
  let nextPlayTime = 0;
  let isMicOn = false;
  let reconnectTimer = null;
  let isConnected = false;

  const SAMPLE_RATE = 16000; // 16kHz high-clarity voice

  /* ── Determine station ────────────────────────────────────────────── */
  function getStation() {
    const p = window.location.pathname;
    if (p.includes('kitchen')) return 'kitchen';
    if (p.includes('service')) return 'service';
    if (p.includes('display')) return 'display';
    return 'manager';
  }

  const STATION_LABELS = {
    manager: 'Manager',
    kitchen: 'Kitchen',
    service: 'Service',
    display: 'Display',
  };

  /* ── Inject CSS ───────────────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('intercom-styles')) return;
    const style = document.createElement('style');
    style.id = 'intercom-styles';
    style.textContent = `
      #intercom-fab {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: #334155;
        color: #fff;
        border: 2.5px solid rgba(255,255,255,0.2);
        cursor: pointer;
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.15s, background 0.2s, box-shadow 0.2s;
        outline: none;
        user-select: none;
        box-shadow: 0 4px 18px rgba(0,0,0,0.3);
      }
      #intercom-fab:hover  { transform: scale(1.08); }
      #intercom-fab:active { transform: scale(0.93); }

      #intercom-fab.mic-on {
        background: #ea580c !important;
        animation: intercom-pulse 1.3s ease-in-out infinite;
      }
      @keyframes intercom-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(234,88,12,0.65), 0 4px 18px rgba(0,0,0,0.3); }
        70%  { box-shadow: 0 0 0 16px rgba(234,88,12,0), 0 4px 18px rgba(0,0,0,0.3); }
        100% { box-shadow: 0 0 0 0 rgba(234,88,12,0), 0 4px 18px rgba(0,0,0,0.3); }
      }

      #intercom-status-dot {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #94a3b8;
        border: 2px solid #fff;
        z-index: 100000;
        pointer-events: none;
        transition: background 0.3s;
      }
      #intercom-status-dot.online  { background: #22c55e; }
      #intercom-status-dot.talking { background: #ea580c; animation: intercom-dot-blink 0.6s infinite; }
      @keyframes intercom-dot-blink {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.2; }
      }

      #intercom-toast {
        position: fixed;
        bottom: 92px;
        right: 24px;
        background: rgba(15,23,42,0.92);
        color: #f8fafc;
        padding: 8px 16px;
        border-radius: 10px;
        font-size: 0.82rem;
        font-weight: 700;
        z-index: 100000;
        pointer-events: none;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 0.25s, transform 0.25s;
        display: flex;
        align-items: center;
        gap: 8px;
        box-shadow: 0 4px 18px rgba(0,0,0,0.35);
        backdrop-filter: blur(4px);
      }
      #intercom-toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      #intercom-toast .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ea580c;
        animation: intercom-dot-blink 0.6s infinite;
      }

      /* Modal for insecure origin instructions */
      #intercom-help-modal {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 100001;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 1rem;
      }
      #intercom-help-modal.show { display: flex; }
      .intercom-modal-card {
        background: #ffffff;
        color: #1e293b;
        max-width: 520px;
        width: 100%;
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 20px 40px rgba(0,0,0,0.3);
        font-family: inherit;
      }
    `;
    document.head.appendChild(style);
  }

  /* ── Build UI elements ────────────────────────────────────────────── */
  function createUI() {
    const fab = document.createElement('button');
    fab.id = 'intercom-fab';
    fab.title = 'Intercom — tap to talk';
    fab.innerHTML = micSVG();
    fab.addEventListener('click', () => {
      // Warm up audio context on user interaction (bypasses browser autoplay block)
      warmupPlaybackAudio();
      toggleMic();
    });
    document.body.appendChild(fab);

    const dot = document.createElement('div');
    dot.id = 'intercom-status-dot';
    document.body.appendChild(dot);

    const toast = document.createElement('div');
    toast.id = 'intercom-toast';
    toast.innerHTML = `<span class="dot"></span><span id="intercom-toast-label">Speaking…</span>`;
    document.body.appendChild(toast);

    // Also attach warm-up on any click anywhere once
    const warmupOnce = () => {
      warmupPlaybackAudio();
      window.removeEventListener('click', warmupOnce);
      window.removeEventListener('keydown', warmupOnce);
    };
    window.addEventListener('click', warmupOnce, { once: true });
    window.addEventListener('keydown', warmupOnce, { once: true });
  }

  function micSVG() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
      <line x1="8" y1="22" x2="16" y2="22"/>
    </svg>`;
  }

  function micOffSVG() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="1" y1="1" x2="23" y2="23"/>
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/>
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
      <line x1="12" y1="19" x2="12" y2="22"/>
      <line x1="8" y1="22" x2="16" y2="22"/>
    </svg>`;
  }

  /* ── Audio Context Initializer & Playback ─────────────────────────── */
  function warmupPlaybackAudio() {
    try {
      if (!playbackCtx) {
        playbackCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      }
      if (playbackCtx.state === 'suspended') {
        playbackCtx.resume();
      }
    } catch (e) {
      console.warn('[Intercom] AudioContext warmup failed', e);
    }
  }

  function playPcmChunk(arrayBuffer) {
    warmupPlaybackAudio();
    if (!playbackCtx) return;

    try {
      const int16 = new Int16Array(arrayBuffer);
      if (int16.length === 0) return;

      // Convert 16-bit PCM integer back to float samples [-1.0, 1.0]
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
      }

      const audioBuffer = playbackCtx.createBuffer(1, float32.length, SAMPLE_RATE);
      audioBuffer.getChannelData(0).set(float32);

      const source = playbackCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(playbackCtx.destination);

      const currentTime = playbackCtx.currentTime;
      if (nextPlayTime < currentTime) {
        nextPlayTime = currentTime + 0.04; // 40ms safety buffer
      }
      source.start(nextPlayTime);
      nextPlayTime += audioBuffer.duration;
    } catch (err) {
      console.error('[Intercom] playPcmChunk error', err);
    }
  }

  /* ── Toast Helpers ────────────────────────────────────────────────── */
  let toastTimer = null;
  function showToast(label) {
    const el = document.getElementById('intercom-toast');
    const lbl = document.getElementById('intercom-toast-label');
    if (!el || !lbl) return;
    lbl.textContent = label;
    el.classList.add('show');
    clearTimeout(toastTimer);
  }
  function hideToast() {
    const el = document.getElementById('intercom-toast');
    if (el) el.classList.remove('show');
  }

  function updateFab() {
    const fab = document.getElementById('intercom-fab');
    const dot = document.getElementById('intercom-status-dot');
    if (!fab) return;

    if (isMicOn) {
      fab.classList.add('mic-on');
      fab.innerHTML = micOffSVG();
      fab.title = 'Intercom ON — tap to stop';
      if (dot) dot.className = 'talking';
    } else {
      fab.classList.remove('mic-on');
      fab.innerHTML = micSVG();
      fab.title = 'Intercom — tap to talk';
      if (dot) dot.className = isConnected ? 'online' : '';
    }
  }

  function toggleMic() {
    if (isMicOn) stopMic();
    else startMic();
  }

  /* ── Insecure Origin Helper (Browser HTTP Mic Security) ──────────── */
  function showInsecureOriginHelp() {
    let modal = document.getElementById('intercom-help-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'intercom-help-modal';
      const currentHost = window.location.hostname;
      const origin3000 = `http://${currentHost}:3000`;
      const origin3001 = `http://${currentHost}:3001`;

      modal.innerHTML = `
        <div class="intercom-modal-card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <h3 style="margin:0; font-size:1.15rem; font-weight:800; color:#ea580c; display:flex; align-items:center; gap:8px;">
              🎤 Enable Microphone on this PC
            </h3>
            <button onclick="document.getElementById('intercom-help-modal').classList.remove('show')" 
                    style="border:none; background:none; font-size:1.4rem; cursor:pointer; color:#64748b;">✕</button>
          </div>
          <p style="font-size:0.88rem; color:#475569; line-height:1.5; margin-bottom:14px;">
            Chrome & Edge block microphone access on IP addresses (like <code>${currentHost}</code>) over plain HTTP. 
            Enable it in 30 seconds:
          </p>
          <ol style="font-size:0.85rem; color:#334155; line-height:1.6; padding-left:20px; margin-bottom:16px;">
            <li>Open a new tab and paste:<br>
              <code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; font-weight:700; color:#ea580c; user-select:all;">chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>
            </li>
            <li style="margin-top:6px;">Paste this exact address into the box:<br>
              <code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; font-weight:700; color:#0284c7; user-select:all;">${origin3000},${origin3001}</code>
            </li>
            <li style="margin-top:6px;">Change dropdown to <b>Enabled</b> and click <b>Relaunch</b> at the bottom.</li>
          </ol>
          <button onclick="document.getElementById('intercom-help-modal').classList.remove('show')" 
                  style="width:100%; padding:10px; border:none; background:#ea580c; color:#fff; font-weight:700; border-radius:10px; cursor:pointer;">
            Got it, I will do this
          </button>
        </div>
      `;
      document.body.appendChild(modal);
    }
    modal.classList.add('show');
  }

  /* ── Start mic recording (Raw PCM) ────────────────────────────────── */
  async function startMic() {
    if (!isConnected) {
      alert('Intercom connecting to server. Please wait 2 seconds and try again.');
      return;
    }

    // Check if mediaDevices is supported
    const hasMediaDevices = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!hasMediaDevices) {
      // Check legacy getUserMedia
      const legacyGetUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
      if (!legacyGetUserMedia) {
        showInsecureOriginHelp();
        return;
      }
    }

    try {
      let stream = null;
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: SAMPLE_RATE,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false
        });
      } else {
        // Fallback legacy getUserMedia
        stream = await new Promise((resolve, reject) => {
          const fn = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
          fn.call(navigator, { audio: true }, resolve, reject);
        });
      }

      micStream = stream;

      // Create Web Audio recording graph
      recordCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      const source = recordCtx.createMediaStreamSource(stream);

      // ScriptProcessorNode to capture raw PCM blocks
      recordProcessor = recordCtx.createScriptProcessor(2048, 1, 1);

      recordProcessor.onaudioprocess = (e) => {
        if (!isMicOn || !ws || ws.readyState !== WebSocket.OPEN) return;
        const inputData = e.inputBuffer.getChannelData(0);

        // Convert Float32 samples to 16-bit PCM Int16
        const int16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Send raw PCM buffer directly
        try {
          ws.send(int16.buffer);
        } catch (err) {
          console.error('[Intercom] Send error', err);
        }
      };

      source.connect(recordProcessor);
      recordProcessor.connect(recordCtx.destination);

      isMicOn = true;
      updateFab();

      // Notify others that this station is speaking
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mic_on', station: getStation() }));
      }

    } catch (err) {
      console.error('[Intercom] Mic start error', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert('Microphone permission denied.\nPlease click the lock/icon in your browser address bar and set Microphone to "Allow".');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        alert('No microphone was found on this computer.');
      } else {
        showInsecureOriginHelp();
      }
    }
  }

  /* ── Stop mic ─────────────────────────────────────────────────────── */
  function stopMic() {
    if (recordProcessor) {
      try { recordProcessor.disconnect(); } catch (e) {}
      recordProcessor = null;
    }
    if (recordCtx) {
      try { recordCtx.close(); } catch (e) {}
      recordCtx = null;
    }
    if (micStream) {
      try {
        micStream.getTracks().forEach(t => t.stop());
      } catch (e) {}
      micStream = null;
    }

    isMicOn = false;
    updateFab();
    hideToast();

    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'mic_off', station: getStation() }));
      } catch (e) {}
    }
  }

  /* ── WebSocket Connection ─────────────────────────────────────────── */
  function connect() {
    clearTimeout(reconnectTimer);
    const station = getStation();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const url = `${proto}//${host}:3001?station=${encodeURIComponent(station)}`;

    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      isConnected = true;
      const dot = document.getElementById('intercom-status-dot');
      if (dot && !isMicOn) dot.className = 'online';
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        // Raw PCM audio received from another station!
        playPcmChunk(e.data);
      } else if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          const label = STATION_LABELS[msg.station] || msg.station || 'Unknown';
          if (msg.type === 'mic_on') {
            showToast(`🎤 ${label} is speaking…`);
          } else if (msg.type === 'mic_off') {
            hideToast();
          }
        } catch (err) {}
      }
    };

    ws.onclose = () => {
      isConnected = false;
      if (isMicOn) stopMic();
      const dot = document.getElementById('intercom-status-dot');
      if (dot) dot.className = '';
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will handle reconnect
    };
  }

  function scheduleReconnect() {
    reconnectTimer = setTimeout(connect, 3000);
  }

  /* ── Init ─────────────────────────────────────────────────────────── */
  function init() {
    injectStyles();
    createUI();
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
