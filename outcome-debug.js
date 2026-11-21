// outcome-debug.js - ?debug=1 section for Phases 5a and 5b. Loaded only in debug mode.
// Shows what the basket finder, the chain-sound detector and the disc tracker see (blobs, track,
// verdicts with their confidence factors), copies the verdict log, and records short local video +
// audio clips (downloaded to the phone) so detection can be tuned against real footage.
// No detection logic lives here.

import { CONFIG } from './config.js';

const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d));

/**
 * createOutcomeDebug(root, { video, finder, chains, getStreams, outcome })
 * Appends a collapsible section to `root`. Returns { update() } (cheap; call a few times a second).
 */
export function createOutcomeDebug(root, {
  video, finder, chains, getStreams, outcome, getDiagnostics = () => ({}),
}) {
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
  // Build one ZIP so mobile browsers only need to approve one download. The archive uses
  // uncompressed ZIP entries; this keeps the exporter dependency-free and fast for frame logs.
  function makeZip(files) {
    const encoder = new TextEncoder();
    const crcTable = makeZip.crcTable || (makeZip.crcTable = (() => {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
      return table;
    })());
    const crc32 = (bytes) => {
      let c = 0xffffffff;
      for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const u16 = (v) => [v & 255, (v >>> 8) & 255];
    const u32 = (v) => [...u16(v & 0xffff), ...u16(Math.floor(v / 65536))];
    const local = []; const central = []; let offset = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);
      const header = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(name.length), ...u16(0), ...name,
      ]);
      local.push(header, data);
      const dir = new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
      ]);
      central.push(dir);
      offset += header.length + data.length;
    }
    const centralSize = central.reduce((n, b) => n + b.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }

  function downloadReport() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const diagnostics = getDiagnostics() || {};
    const oi = outcome.getInfo();
    const replays = outcome.getReplays();
    const verdicts = oi.judge.log || [];
    const chainsNow = chains.getInfo();
    const swing = diagnostics.swing || { samples: [], events: [] };
    const frames = replays.flatMap((r) => (r.frames || []).map((frame) => ({ throwId: r.id, ...frame })));
    const report = {
      saved: new Date().toISOString(),
      app: 'Disc Golf Putting Counter',
      config: CONFIG,
      diagnostics,
      outcome: { watcher: oi.watcher, gate: oi.gate, pending: oi.judge.pending, verdicts },
      audio: chainsNow,
      replayCount: replays.length,
      replays,
      frameDataNote: 'Every analyzed disc-worker/main-thread frame retained by the replay buffer for each saved throw (release -2s through evaluation horizon). Each frame includes timestamp, blobs, foreground ratio, dropped-frame count, warmup state, and player mask.',
    };
    const swingText = (swing.events || []).map((e) => JSON.stringify(e)).join('\n') || 'no swing events';
    const verdictText = verdicts.map((v) => JSON.stringify(v)).join('\n') || 'no verdicts';
    const frameHeader = 'throwId,t,fgOut,dropped,warm,player,blobCount,blobsJson';
    const frameCsv = [frameHeader, ...frames.map((f) => [
      f.throwId, f.t, f.fgOut, f.dropped, f.warm,
      JSON.stringify(f.player || null), (f.blobs || []).length,
      JSON.stringify(f.blobs || []),
    ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const summary = [
      `Saved: ${report.saved}`,
      `Completed replay throws: ${replays.length}`,
      `Verdicts: ${verdicts.length}`,
      `Captured analyzed frames: ${frames.length}`,
      `Swing events: ${(swing.events || []).length}`,
      `Pose stats: ${JSON.stringify(diagnostics.pose || {})}`,
      `Camera stats: ${JSON.stringify(diagnostics.camera || {})}`,
      `Disc watcher: ${JSON.stringify(oi.watcher || {})}`,
      '',
      'Frame coverage: each replay includes the retained analyzed frames from 2 seconds before release through the evaluation horizon (currently 4.5 seconds after release).',
      'The JSON contains full per-throw replay objects, frame/blob data, release snapshots, verdict evidence, config, and current diagnostics.',
    ].join('\n');
    const zip = makeZip([
      { name: 'report.json', data: JSON.stringify(report, null, 2) },
      { name: 'session-summary.txt', data: summary },
      { name: 'swing-log.jsonl', data: swingText },
      { name: 'verdict-log.jsonl', data: verdictText },
      { name: 'frame-data.csv', data: frameCsv },
      { name: 'chain-audio-log.json', data: JSON.stringify(chainsNow, null, 2) },
    ]);
    const url = URL.createObjectURL(zip);
    const a = document.createElement('a');
    a.href = url;
    a.download = `putt-report-${stamp}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    reportBtn.textContent = 'Report downloaded';
    setTimeout(() => { reportBtn.textContent = 'Download report'; }, 1800);
  }
  const reportBtn = button('Download report', downloadReport);

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
    // Disc tracker: corridor, latest blobs, and the newest track (pending throw, else last verdict).
    const oi = outcome.getInfo();
    if (oi.watcher.roi) {
      const r = oi.watcher.roi;
      vg.strokeStyle = 'rgba(255,255,255,0.7)';
      vg.setLineDash([5, 4]);
      vg.strokeRect(r.x0 * W, r.y0 * H, (r.x1 - r.x0) * W, (r.y1 - r.y0) * H);
      vg.setLineDash([]);
    }
    if (oi.frame) {
      for (const q of oi.frame.blobs) {
        vg.strokeStyle = q.move >= CONFIG.OUTCOME.MIN_MOVE ? '#4dd' : '#999';
        vg.lineWidth = 1;
        vg.strokeRect(q.x * W - 4, q.y * H - 4, 8, 8);
      }
    }
    const pend = oi.judge.pending.find((p) => p.last && p.last.ev && p.last.ev.trk);
    const lastV = oi.judge.log[oi.judge.log.length - 1];
    const trkPts = pend ? pend.last.ev.trk.pts : (lastV && lastV.ev && lastV.ev.trk ? lastV.ev.trk.pts : null);
    if (trkPts) {
      vg.strokeStyle = '#f0f';
      vg.lineWidth = 2;
      vg.beginPath();
      trkPts.forEach((p, i) => { if (i) vg.lineTo(p[0] * W, p[1] * H); else vg.moveTo(p[0] * W, p[1] * H); });
      vg.stroke();
      for (const p of trkPts) vg.fillRect(p[0] * W - 2, p[1] * H - 2, 4, 4);
    }
    const L = info.locked;
    if (L) {
      vg.strokeStyle = '#00d84a';
      vg.lineWidth = 2;
      vg.beginPath(); vg.moveTo(L.xn * W, 0); vg.lineTo(L.xn * W, H); vg.stroke();
      if (L.yn != null) box(L, '#00d84a', 3);
    }
  }

  // ---- Disc tracker / verdict read-out --------------------------------------------------------
  const pct = (v) => (v == null ? '--' : f(v, 2));
  const factorText = (fa) => Object.entries(fa || {}).map(([k, v]) => `${k} ${pct(v)}`).join(' ');
  function outcomeLines() {
    const o = outcome.getInfo();
    const w = o.watcher;
    const lines = [
      `disc: gate ${o.gate === null ? 'ok' : o.gate} \u00b7 watcher ${w.roi ? 'on' : 'idle'} (${w.mode}) ${f(w.fps, 0)} fps ${f(w.ms, 1)} ms`
        + ` \u00b7 fg ${f(w.fgOut * 100, 2)}% \u00b7 ${w.w}x${w.h}px \u00b7 blobs ${o.frame ? o.frame.blobs.length : 0}`
        + (o.frame && o.frame.dropped ? ` \u00b7 dropped ${o.frame.dropped}` : ''),
    ];
    for (const p of o.judge.pending) {
      const l = p.last;
      lines.push(`  WAIT #${p.id} ${f((performance.now() - p.t) / 1000)} s`
        + (l && l.ev && l.ev.trk ? ` \u00b7 track ${l.ev.trk.n} pts rms ${f(l.ev.trk.rms, 2)} dens ${pct(l.ev.trk.density)}` : ' \u00b7 no track yet')
        + (l && l.ev && l.ev.arr ? ` \u00b7 arrived${l.ev.arr.inferred ? ' (inferred)' : ''}` : ''));
    }
    for (const v of o.judge.log.slice(-4).reverse()) {
      const e = v.ev || {};
      lines.push(`  #${v.id} ${v.result.toUpperCase()}${v.dir ? ` ${v.dir}` : ''} \u00b7 conf ${pct(v.conf)} \u00b7 ${v.reason}`
        + ` \u00b7 ${f(v.distanceFt, 0)} ft \u00b7 after ${f(v.decidedAfterMs / 1000)} s`);
      lines.push(`     ${e.trk ? `trk ${e.trk.n} pts rms ${f(e.trk.rms, 2)} dens ${pct(e.trk.density)} \u00b7 ` : ''}`
        + `${e.chain ? `chain ${f(e.chain.dtMs, 0)} ms rise ${f(e.chain.riseDb, 0)} dB \u00b7 ` : ''}`
        + `${e.rest ? `rest u ${f(e.rest.u)} v ${f(e.rest.v)} x${e.rest.count} \u00b7 ` : ''}`
        + `${e.stay ? `stay x${e.stay.count} \u00b7 ` : ''}${e.trackless ? 'no track \u00b7 ' : ''}`
        + `${e.exit ? `exit ${e.exit.n} pts \u00b7 ` : ''}`
        + `${e.cover ? `fps ${f(e.cover.fps, 0)} gap ${f(e.cover.maxGapMs, 0)} \u00b7 ` : ''}`
        + `base ${pct(e.baseFrac)} weak ${e.exitWeakFrames ?? '--'} \u00b7 ${factorText(e.factors)}`);
    }
    return lines;
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
      ...outcomeLines(),
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
