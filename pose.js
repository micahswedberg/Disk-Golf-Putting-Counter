// pose.js - MediaPipe Pose Landmarker wrapper. Returns landmarks per frame; no game logic here.
//
// Why crops: the model's person detector looks at a ~224 px square. A 5-6 ft player 25-30 ft from
// the phone is only ~20% of a 1080p frame's height, about 25 px once the whole frame is shrunk,
// too small to detect. So:
//   search: sweep overlapping square tiles across the frame until a person is found
//   track : crop a square around the last known person
// IMAGE mode is used (no model-side tracking state), so crops can change every frame.
// Landmarks are returned in full-frame normalized coords (0..1; outside that range = cut off).

import { CONFIG } from './config.js';

const P = CONFIG.POSE;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * createPose({ video, onFrame, onStatus })
 *   onFrame({ t, w, h, landmarks|null, mode })  after every processed video frame
 *   onStatus('idle'|'loading'|'ready'|'failed')
 * Returns { start(), stop(), getStatus(), getStats() }.
 */
export function createPose({ video, onFrame, onStatus }) {
  const canvas = document.createElement('canvas');
  canvas.width = P.CROP_PX;
  canvas.height = P.CROP_PX;
  const g = canvas.getContext('2d');

  let landmarker = null;
  let loading = null;
  let status = 'idle';
  let delegate = null;
  let running = false;

  let mode = 'search'; // 'search' | 'track'
  let tiles = [];
  let tileIdx = 0;
  let planKey = '';
  let track = null; // { cx, cy, side } in frame px
  let fails = 0;

  let inferMs = 0;
  let fps = 0;
  let lastT = 0;

  function setStatus(s) {
    if (s === status) return;
    status = s;
    if (onStatus) onStatus(s);
  }

  async function load() {
    const mod = await import(P.BUNDLE_URL);
    const fileset = await mod.FilesetResolver.forVisionTasks(P.WASM_URL);
    const make = (d) => mod.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: P.MODEL_URL, delegate: d },
      runningMode: 'IMAGE',
      numPoses: 1,
      minPoseDetectionConfidence: P.MIN_DETECT_CONF,
      minPosePresenceConfidence: P.MIN_PRESENCE_CONF,
    });
    try {
      landmarker = await make('GPU');
      delegate = 'GPU';
    } catch (err) {
      console.warn('pose: GPU delegate failed, using CPU', err);
      landmarker = await make('CPU');
      delegate = 'CPU';
    }
  }

  /** Overlapping square tiles that cover the frame, middle row first. */
  function planTiles(W, H) {
    const side = Math.round(Math.min(H, W) * P.TILE_FRAC);
    const step = Math.max(1, Math.round(side * P.TILE_STEP_FRAC));
    const xs = [];
    for (let x = 0; x + side < W; x += step) xs.push(x);
    xs.push(W - side);
    const out = [];
    for (const c of P.SEARCH_ROW_CENTERS) {
      const sy = clamp(Math.round(c * H - side / 2), 0, H - side);
      for (const sx of xs) out.push({ sx, sy, side });
    }
    return out;
  }

  /** Bounding box (px) of landmarks seen with some confidence, or null. */
  function bbox(lms, W, H) {
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
    for (const p of lms) {
      if (p.visibility < 0.3) continue;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (x0 === Infinity) return null;
    return { x0: x0 * W, x1: x1 * W, y0: y0 * H, y1: y1 * H };
  }

  function step() {
    const W = video.videoWidth;
    const H = video.videoHeight;
    if (!W || !H || video.readyState < 2) return;
    const key = `${W}x${H}`;
    if (key !== planKey) {
      planKey = key;
      tiles = planTiles(W, H);
      tileIdx = 0;
      track = null;
      mode = 'search';
    }

    const t0 = performance.now();
    const usedMode = mode;
    let crop;
    if (mode === 'track' && track) {
      const side = Math.round(track.side);
      crop = {
        side,
        sx: clamp(Math.round(track.cx - side / 2), 0, W - side),
        sy: clamp(Math.round(track.cy - side / 2), 0, H - side),
      };
    } else {
      crop = tiles[tileIdx % tiles.length];
      tileIdx += 1;
    }

    g.drawImage(video, crop.sx, crop.sy, crop.side, crop.side, 0, 0, P.CROP_PX, P.CROP_PX);
    const res = landmarker.detect(canvas);
    const raw = res && res.landmarks && res.landmarks[0];

    let full = null;
    if (raw) {
      const mapped = raw.map((p) => ({
        x: (crop.sx + p.x * crop.side) / W,
        y: (crop.sy + p.y * crop.side) / H,
        visibility: p.visibility ?? 0,
      }));
      const b = bbox(mapped, W, H);
      if (b && b.y1 - b.y0 >= P.MIN_BBOX_FRAC * H) {
        full = mapped;
        // Lock the next crop onto this person. The crop only shrinks slowly, so bending
        // over (smaller bbox) does not lose them.
        const bh = b.y1 - b.y0;
        const side = clamp(
          Math.max(bh * P.TRACK_PAD, track ? track.side * 0.98 : 0, H * P.TRACK_MIN_SIDE_FRAC),
          0,
          H,
        );
        track = { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, side };
        mode = 'track';
        fails = 0;
      }
    }
    if (!full && mode === 'track') {
      fails += 1;
      if (fails >= P.TRACK_FAIL_FRAMES) {
        mode = 'search';
        track = null;
        tileIdx = 0;
        fails = 0;
      }
    }

    const now = performance.now();
    inferMs = inferMs ? inferMs * 0.9 + (now - t0) * 0.1 : now - t0;
    if (lastT) fps = fps ? fps * 0.9 + (1000 / (now - lastT)) * 0.1 : 1000 / (now - lastT);
    lastT = now;

    if (onFrame) onFrame({ t: now, w: W, h: H, landmarks: full, mode: usedMode });
  }

  function tick() {
    if (!running) return;
    try {
      step();
    } catch (err) {
      console.warn('pose: frame failed', err);
    }
    schedule();
  }

  function schedule() {
    if (!running) return;
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  async function start() {
    if (running) return;
    running = true;
    mode = 'search';
    track = null;
    fails = 0;
    tileIdx = 0;
    planKey = '';
    lastT = 0;
    if (!landmarker) {
      setStatus('loading');
      try {
        loading = loading || load();
        await loading;
      } catch (err) {
        console.error('pose: model failed to load', err);
        loading = null;
        running = false;
        setStatus('failed');
        return;
      }
    }
    if (!running) return; // stopped while the model was loading
    setStatus('ready');
    schedule();
  }

  function stop() {
    running = false;
    setStatus('idle');
  }

  return {
    start,
    stop,
    getStatus: () => status,
    getStats: () => ({ status, mode, inferMs, fps, delegate }),
  };
}
