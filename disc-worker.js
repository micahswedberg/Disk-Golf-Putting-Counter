// disc-worker.js - analyses the camera frames off the main thread (Phase 5b).
//
// Pose tracking keeps the main thread ~90% busy (about 80 ms a frame), which left the disc tracker
// about 6 frames a second: too few to follow a putt. Here the camera's frames arrive through a
// MediaStreamTrackProcessor stream, the corridor is cut out, and the blob extraction from outcome.js
// runs at the camera's own rate. Results go back to the page as small frame records.
//
// Messages in:  { type: 'init', readable, timeOrigin, roi, player } | { type: 'roi', roi } |
//               { type: 'player', player } | { type: 'reset' } | { type: 'stop' }
// Messages out: { type: 'frame', f } | { type: 'info', info } | { type: 'error', message }

import { CONFIG } from './config.js';
import { analysisSize, createFrameAnalyzer } from './outcome.js';

const C = CONFIG.OUTCOME;
const analyzer = createFrameAnalyzer(C);
let roi = null;
let player = null;
let stopped = false;
let originShift = 0; // worker clock -> page clock (both are performance.now() based)
let canvas = null;
let g = null;

let n = 0; let fpsT = 0; let fps = 0; let msAvg = 0; let lastW = 0; let lastH = 0;

function handle(frame) {
  if (!roi) return;
  const t0 = performance.now();
  const vw = frame.displayWidth;
  const vh = frame.displayHeight;
  const z = analysisSize(vw, vh, roi, C);
  if (!canvas || canvas.width !== z.w || canvas.height !== z.h) {
    canvas = new OffscreenCanvas(z.w, z.h);
    g = canvas.getContext('2d', { willReadFrequently: true });
  }
  g.drawImage(frame, z.sx, z.sy, z.sw, z.sh, 0, 0, z.w, z.h);
  const px = g.getImageData(0, 0, z.w, z.h).data;
  const f = analyzer.run(px, z.w, z.h, roi, player, t0 + originShift);
  const ms = performance.now() - t0;
  msAvg = msAvg ? 0.9 * msAvg + 0.1 * ms : ms;
  lastW = z.w; lastH = z.h;
  f.ms = ms;
  postMessage({ type: 'frame', f });
  n += 1;
  const now = performance.now();
  if (now - fpsT >= 1000) {
    fps = (n * 1000) / (now - fpsT);
    n = 0; fpsT = now;
    postMessage({ type: 'info', info: { fps, ms: msAvg, w: lastW, h: lastH } });
  }
}

async function loop(readable) {
  const reader = readable.getReader();
  try {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      try { handle(frame); } finally { frame.close(); }
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    originShift = performance.timeOrigin - m.timeOrigin;
    roi = m.roi || null;
    player = m.player || null;
    fpsT = performance.now();
    loop(m.readable);
  } else if (m.type === 'roi') {
    roi = m.roi;
    analyzer.reset();
  } else if (m.type === 'player') {
    player = m.player;
  } else if (m.type === 'reset') {
    analyzer.reset();
  } else if (m.type === 'stop') {
    stopped = true;
  }
};
