// outcome-debug.js - ?debug=1 section for Phase 5a. Loaded only in debug mode.
// Shows what the basket finder and the chain-sound detector see, and records short local
// video + audio clips (downloaded to the phone) so detection can be tuned against real footage.
// No detection logic lives here.

import { CONFIG } from './config.js';

const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));

/**
 * createOutcomeDebug(root, { video, finder, chains, getStreams })
 * Appends a collapsible section to `root`. Returns { update() } (cheap; call a few times a second).
 */
export function createOutcomeDebug(root, { video, finder, chains, getStreams }) {
  const B = CONFIG.BASKET;
  const C = CONFIG.CHAIN;
  const R = CONFIG.DEBUG_REC;

  const sec = document.createElement('div');
  sec.innerHTML = `
    <div class="dbg-bar"><button type="button" class="o-toggle">OUT</button><span class="o-state"></span></div>
    <div class="dbg-body o-body" hidden>
      <div class="o-actions"></div>
      <canvas class="o-view" width="480" height="270" style="width:100%;max-width:480px;display:block;margin-top:4px"></canvas>
      <canvas class="o-trace" width="640" height="150" style="width:100%;max-width:640px;display:block;margin-top:4px"></canvas>
      <pre class="dbg-read o-read"></pre>
    </div>`;
  root.appendChild(sec);

  const body = sec.querySelector('.o-body');
  const stateEl = sec.querySelector('.o-state');
  const readEl = sec.querySelector('.o-read');
  const viewEl = sec.querySelector('.o-view');
  const vg = viewEl.getContext('2d');
  const traceEl = sec.querySelector('.o-trace');
  const tg = traceEl.getContext('2d');
  sec.querySelector('.o-toggle').addEventListener('click', () => { body.hidden = !body.hidden; });

  // ---- Buttons ------------------------------------------------------------------------------
  const actions = sec.querySelector('.o-actions');
  const button = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  button('Re-find basket', () => finder.reset());
  const recBtn = button('Record clip', () => (rec ? stopRecording() : startRecording()));

  // ---- Clip recorder ------------------------------------------------------------------------
  let rec = null;
  let recStart = 0;
  let recTimer = 0;
  let recNote = '';

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  function startRecording() {
    const { video: vs, audio: as } = getStreams();
    const mime = pickMime();
    if (mime === null) { recNote = 'recorder unsupported'; return; }
    if (!vs) { recNote = 'no camera stream'; return; }
    const tracks = [...vs.getVideoTracks(), ...(as ? as.getAudioTracks() : [])];
    const chunks = [];
    try {
      rec = new MediaRecorder(new MediaStream(tracks), {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: R.VIDEO_BPS,
        audioBitsPerSecond: R.AUDIO_BPS,
      });
    } catch (err) {
      rec = null;
      recNote = `recorder failed: ${err.name}`;
      return;
    }
    const type = rec.mimeType || mime || 'video/webm';
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      clearTimeout(recTimer);
      const secs = Math.round((performance.now() - recStart) / 1000);
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `putt-${stamp}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      recNote = `saved ${a.download} (${secs} s, ${(blob.size / 1e6).toFixed(1)} MB)`;
      rec = null;
      render();
    };
    rec.start(1000);
    recStart = performance.now();
    recNote = '';
    recTimer = setTimeout(stopRecording, R.MAX_MS);
  }

  function stopRecording() {
    if (rec && rec.state !== 'inactive') rec.stop();
  }

  // ---- Audio trace --------------------------------------------------------------------------
  const TRACE_MS = 6000;
  const trace = []; // { t, rise, lowRise }
  let lastEventT = 0;
  const marks = []; // { t, peak }

  function sampleAudio() {
    const a = chains.getInfo();
    const now = performance.now();
    if (a.ok && a.live) trace.push({ t: now, rise: a.live.rise, lowRise: a.live.lowRise });
    while (trace.length && now - trace[0].t > TRACE_MS) trace.shift();
    for (const e of a.events) {
      if (e.t > lastEventT) { lastEventT = e.t; marks.push({ t: e.t, peak: e.peakDb, dur: e.durMs }); }
    }
    while (marks.length && now - marks[0].t > TRACE_MS) marks.shift();
  }

  function drawTrace() {
    const W = traceEl.width;
    const H = traceEl.height;
    const MAXDB = 40;
    const now = performance.now();
    tg.fillStyle = '#111';
    tg.fillRect(0, 0, W, H);
    const xOf = (t) => W * (1 - (now - t) / TRACE_MS);
    const yOf = (db) => H - 4 - (Math.min(Math.max(db, 0), MAXDB) / MAXDB) * (H - 18);
    tg.setLineDash([4, 4]);
    tg.strokeStyle = '#d33';
    tg.beginPath(); tg.moveTo(0, yOf(C.ONSET_DB)); tg.lineTo(W, yOf(C.ONSET_DB)); tg.stroke();
    tg.setLineDash([]);
    for (const [key, color] of [['lowRise', '#fa3'], ['rise', '#4dd']]) {
      tg.strokeStyle = color;
      tg.lineWidth = 1.5;
      tg.beginPath();
      trace.forEach((s, i) => {
        const x = xOf(s.t);
        const y = yOf(s[key]);
        if (i) tg.lineTo(x, y); else tg.moveTo(x, y);
      });
      tg.stroke();
    }
    tg.font = '13px monospace';
    for (const m of marks) {
      const x = xOf(m.t);
      tg.strokeStyle = '#3d6';
      tg.lineWidth = 2;
      tg.beginPath(); tg.moveTo(x, 14); tg.lineTo(x, H); tg.stroke();
      tg.fillStyle = '#3d6';
      tg.fillText('CHAIN', Math.min(x + 3, W - 50), 12);
    }
    tg.font = '12px monospace';
    tg.fillStyle = '#888';
    tg.fillText('chain band rise cyan, low band rise orange, red = onset (dB over floor), last 6 s', 4, H - 4);
  }

  // ---- Basket view --------------------------------------------------------------------------
  function drawView() {
    const W = viewEl.width;
    const H = viewEl.height;
    if (video && video.readyState >= 2 && video.videoWidth) {
      // Raw (unmirrored) frame, so every x here matches the numbers in config and the readout.
      vg.drawImage(video, 0, 0, W, H);
    } else {
      vg.fillStyle = '#222';
      vg.fillRect(0, 0, W, H);
    }
    // Search area.
    vg.strokeStyle = 'rgba(80,200,255,0.9)';
    vg.lineWidth = 1;
    for (const [a, b] of B.SEARCH_X) {
      vg.strokeRect(a * W, B.SEARCH_Y[0] * H, (b - a) * W, (B.SEARCH_Y[1] - B.SEARCH_Y[0]) * H);
    }
    const info = finder.getInfo();
    const box = (b, color, width) => {
      vg.strokeStyle = color;
      vg.lineWidth = width;
      vg.strokeRect((b.xn - b.wn / 2) * W, (b.yn - b.hn / 2) * H, b.wn * W, b.hn * H);
    };
    if (info.candidate) box(info.candidate, '#ffb000', 2);
    const L = info.locked;
    if (L) {
      vg.strokeStyle = '#00d84a';
      vg.lineWidth = 2;
      vg.beginPath(); vg.moveTo(L.xn * W, 0); vg.lineTo(L.xn * W, H); vg.stroke();
      if (L.yn != null) box(L, '#00d84a', 3);
    }
  }

  // ---- Readout ------------------------------------------------------------------------------
  function render() {
    const b = finder.getInfo();
    const a = chains.getInfo();
    const lv = a.levels;
    const lastEv = a.events.slice(-4).reverse();
    const now = performance.now();

    stateEl.textContent = `BASKET ${b.locked ? (b.locked.manual ? 'set (tap)' : 'found') : 'searching'}`
      + ` \u00b7 AUDIO ${a.ok ? 'ok' : 'NO'} \u00b7 CHAIN ${a.events.length}`
      + (rec ? ` \u00b7 REC ${Math.round((now - recStart) / 1000)}s` : '');
    recBtn.textContent = rec ? 'Stop & save clip' : 'Record clip';

    const c = b.candidate;
    readEl.textContent = [
      `basket: ${b.locked ? `x ${f(b.locked.xn, 3)}${b.locked.manual ? ' (manual)' : ''}` : 'not found'}`
        + ` \u00b7 best box ${c ? `x ${f(c.xn, 3)} y ${f(c.yn, 2)} score ${f(c.score, 2)} dens ${f(c.density, 2)}` : 'none'}`
        + ` \u00b7 agree ${b.stable}/${b.need} \u00b7 scan ${f(b.scanMs, 0)} ms \u00b7 n ${b.scans}`,
      `audio: ctx ${a.ctxState} ${a.sampleRate ?? '--'} Hz \u00b7 poll ${f(a.pollFps, 0)}/s \u00b7 ${a.live.state}`
        + (lv ? ` \u00b7 chain band ${f(lv.hf, 0)} dB (floor ${f(a.live.floor, 0)}) \u00b7 low ${f(lv.low, 0)} dB` : ''),
      `rise ${f(a.live.rise)} dB \u00b7 low rise ${f(a.live.lowRise)} \u00b7 attack ${f(a.live.attack)} \u00b7 bands ${a.live.bandsHit}/4`,
      ...lastEv.map((e) => `  CHAIN ${f((now - e.t) / 1000)} s ago \u00b7 dur ${f(e.durMs, 0)} ms \u00b7 peak ${f(e.peakDb, 0)} dB`
        + ` \u00b7 rise ${f(e.riseDb)} \u00b7 low ${f(e.lowRiseDb)} \u00b7 bands ${e.bandsHit}`),
      recNote ? `rec: ${recNote}` : `rec: up to ${R.MAX_MS / 1000} s per clip`,
    ].join('\n');
  }

  function update() {
    sampleAudio();
    render();
    if (!body.hidden) { drawView(); drawTrace(); }
  }

  const timer = setInterval(update, 100);
  update();
  return { update, destroy() { clearInterval(timer); } };
}
