// outcome.js - Phase 5a: basket location and chain-sound detection.
// (Disc tracking and make/miss classification are NOT here yet.)
//
// Two independent parts:
//   1. createBasketFinder  finds the basket's x position in the raw camera frame.
//   2. createChainDetector listens to the mic and emits an event for each chain-rattle burst.
//
// Both keep their signal maths in pure, DOM-free functions (findBasketCandidate, bandsFromSpectrum,
// createSpikeLogic) so they can be tested without a browser. All numbers live in config.js.
// Coordinates: x, y are normalized to the RAW (unmirrored) camera frame, like round.js.

import { CONFIG } from './config.js';

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ===========================================================================================
// 1. BASKET FINDER
//
// Shape heuristic, no colour (basket colours and lighting vary too much to trust). The chain
// cage is a roughly square patch (about 2 ft wide, 2 ft tall) packed with thin vertical lines,
// sitting at the far end of the putt line. For each candidate box we measure the density of
// "vertical-edge" pixels inside it, minus the density in the equally sized boxes to its left and
// right (a fence or tree line is dense on both sides, so it scores low). The best box must stay
// in the same place for several scans in a row before it is accepted, which rejects walkers.
// ===========================================================================================

/**
 * Pure. Best basket box in a luma image band.
 * luma: Uint8 grey values, w x h, covering rows [bandY0, bandY0 + h) of a frame fullH rows tall.
 * exclude: { x0, x1 } normalized columns to ignore (the player), or null.
 * Returns { xn, yn, wn, hn, score, density } in full-frame normalized coords, or null.
 */
export function findBasketCandidate(luma, w, h, bandY0, fullH, exclude, cfg = CONFIG.BASKET) {
  // Vertical-edge map: strong horizontal gradient that clearly beats the vertical gradient.
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    const row = y * w;
    for (let x = 1; x < w - 1; x += 1) {
      const i = row + x;
      const gx = Math.abs(luma[i + 1] - luma[i - 1]);
      if (gx < cfg.EDGE_MIN) continue;
      const gy = Math.abs(luma[i + w] - luma[i - w]);
      if (gx >= cfg.VERT_RATIO * gy) edge[i] = 1;
    }
  }
  if (exclude) {
    const a = Math.max(0, Math.floor((exclude.x0 - cfg.EXCLUDE_PAD) * w));
    const b = Math.min(w - 1, Math.ceil((exclude.x1 + cfg.EXCLUDE_PAD) * w));
    for (let y = 0; y < h; y += 1) for (let x = a; x <= b; x += 1) edge[y * w + x] = 0;
  }

  // Integral image for fast box sums.
  const W1 = w + 1;
  const ii = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let run = 0;
    for (let x = 0; x < w; x += 1) {
      run += edge[y * w + x];
      ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + run;
    }
  }
  // Density of the box [x0, x1) x [y0, y1), clipped to the band. Empty (off-frame) area counts 0.
  const dens = (x0, y0, x1, y1) => {
    const a = Math.max(0, x0); const b = Math.min(w, x1);
    const c = Math.max(0, y0); const d = Math.min(h, y1);
    if (b <= a || d <= c) return 0;
    const s = ii[d * W1 + b] - ii[c * W1 + b] - ii[d * W1 + a] + ii[c * W1 + a];
    return s / ((x1 - x0) * (y1 - y0));
  };

  let best = null;
  const step = cfg.BOX_STEP_PX;
  const yLo = cfg.SEARCH_Y[0] * fullH - bandY0;
  const yHi = cfg.SEARCH_Y[1] * fullH - bandY0;
  for (const frac of cfg.BOX_H_FRACS) {
    const bh = Math.round(frac * fullH);
    const bw = Math.round(bh * cfg.BOX_ASPECT);
    if (bh < 4 || bw < 4 || bh > h) continue;
    for (const [xa, xb] of cfg.SEARCH_X) {
      for (let cx = Math.round(xa * w); cx <= Math.round(xb * w); cx += step) {
        const x0 = cx - (bw >> 1);
        for (let cy = Math.round(yLo); cy <= Math.round(yHi); cy += step) {
          const y0 = cy - (bh >> 1);
          const din = dens(x0, y0, x0 + bw, y0 + bh);
          if (din < cfg.MIN_DENSITY) continue;
          const dl = dens(x0 - bw, y0, x0, y0 + bh);
          const dr = dens(x0 + bw, y0, x0 + 2 * bw, y0 + bh);
          const score = din - cfg.SURROUND_W * Math.max(dl, dr);
          if (!best || score > best.score) {
            best = {
              xn: (x0 + bw / 2) / w,
              yn: (bandY0 + y0 + bh / 2) / fullH,
              wn: bw / w,
              hn: bh / fullH,
              score,
              density: din,
            };
          }
        }
      }
    }
  }
  return best;
}

/**
 * createBasketFinder({ onFound })
 *   onFound(xn) fires once when a candidate has stayed put long enough (or after lock()).
 * Methods: start(video), stop(), reset(), lock(xn), setExclude({x0,x1}|null), getInfo().
 * While searching it scans the video a few times a second; once locked it does nothing.
 */
export function createBasketFinder({ onFound } = {}) {
  const C = CONFIG.BASKET;
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });

  let video = null;
  let timer = 0;
  let locked = null; // { xn, yn, wn, hn, manual }
  let hist = [];
  let cand = null; // latest per-scan best box (for the debug view)
  let stableCount = 0;
  let scans = 0;
  let scanMs = 0;
  let exclude = null;
  let excludeAt = 0;

  function scan() {
    if (!video || locked || video.readyState < 2 || !video.videoWidth) return;
    const t0 = performance.now();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const w = Math.min(C.SCAN_W, vw);
    const fullH = Math.round((vh * w) / vw);
    // Only the rows that can hold the basket are read.
    const maxFrac = Math.max(...C.BOX_H_FRACS);
    const r0 = Math.max(0, C.SEARCH_Y[0] - maxFrac / 2);
    const r1 = Math.min(1, C.SEARCH_Y[1] + maxFrac / 2);
    const bandY0 = Math.floor(r0 * fullH);
    const h = Math.ceil(r1 * fullH) - bandY0;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.drawImage(video, 0, (bandY0 / fullH) * vh, vw, (h / fullH) * vh, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const luma = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < luma.length; i += 1, j += 4) {
      luma[i] = (77 * px[j] + 150 * px[j + 1] + 29 * px[j + 2]) >> 8;
    }
    const ex = exclude && performance.now() - excludeAt <= C.EXCLUDE_TTL_MS ? exclude : null;
    const best = findBasketCandidate(luma, w, h, bandY0, fullH, ex, C);
    cand = best;
    const good = best && best.score >= C.MIN_SCORE ? best : null;
    hist.push(good);
    if (hist.length > C.HISTORY) hist.shift();
    scans += 1;

    // Accept when most of the recent scans agree on one x.
    const valid = hist.filter(Boolean);
    const need = Math.ceil(C.STABLE_FRAC * C.HISTORY);
    stableCount = 0;
    if (valid.length >= need) {
      const mx = median(valid.map((c) => c.xn));
      const agree = valid.filter((c) => Math.abs(c.xn - mx) <= C.STABLE_TOL);
      stableCount = agree.length;
      if (hist.length >= C.HISTORY && agree.length >= need) {
        accept({
          xn: median(agree.map((c) => c.xn)),
          yn: median(agree.map((c) => c.yn)),
          wn: median(agree.map((c) => c.wn)),
          hn: median(agree.map((c) => c.hn)),
          manual: false,
        });
      }
    }
    scanMs = performance.now() - t0;
  }

  function accept(b) {
    locked = b;
    clearInterval(timer);
    timer = 0;
    if (onFound) onFound(b.xn);
  }

  function begin() {
    clearInterval(timer);
    timer = setInterval(scan, C.SCAN_MS);
  }

  return {
    start(v) { video = v; locked = null; hist = []; cand = null; stableCount = 0; begin(); },
    stop() { clearInterval(timer); timer = 0; video = null; },
    /** Forget the basket and search again. */
    reset() { locked = null; hist = []; cand = null; stableCount = 0; if (video) begin(); },
    /** Manual override (debug tap): accept this x and stop searching. */
    lock(xn) {
      accept({ xn, yn: null, wn: null, hn: null, manual: true });
    },
    /** Player's x span in raw-frame coordinates, so the player is not mistaken for the basket. */
    setExclude(span) { exclude = span; excludeAt = performance.now(); },
    getInfo: () => ({
      locked: locked ? { ...locked } : null,
      candidate: cand ? { ...cand } : null,
      stable: stableCount,
      need: Math.ceil(C.STABLE_FRAC * C.HISTORY),
      scans,
      scanMs,
      searching: !!timer,
    }),
  };
}

/** x span (raw-frame normalized) covered by the visible pose landmarks, or null. */
export function playerSpan(landmarks) {
  if (!landmarks) return null;
  let lo = Infinity; let hi = -Infinity;
  for (const p of landmarks) {
    if ((p.visibility ?? 0) < 0.3) continue;
    if (p.x < lo) lo = p.x;
    if (p.x > hi) hi = p.x;
  }
  return hi >= lo ? { x0: lo, x1: hi } : null;
}

// ===========================================================================================
// 2. CHAIN-SOUND DETECTOR
//
// Chain rattle = a short, sudden, broadband burst in the 2-12 kHz range.
//   footsteps  mostly low-frequency thump, so the low band rises more than the high band: rejected
//   wind       rises slowly and lasts long, so the adaptive floor follows it: rejected
//   speech/claps can still slip through; Phase 5b only accepts a sound that follows a visual
//   disc contact, so a lone audio event never scores a putt by itself.
// The microphone is opened by camera.js (echo cancellation, noise suppression and auto gain off).
// ===========================================================================================

/**
 * Pure. Reduce one analyser spectrum (dB per bin, 0 .. Nyquist) to the band levels the spike
 * logic uses: { low, bands: [..], hf } all in dB (power mean over the bins in each band).
 */
export function bandsFromSpectrum(db, sampleRate, cfg = CONFIG.CHAIN) {
  const binHz = sampleRate / 2 / db.length;
  const level = (f0, f1) => {
    const a = Math.max(1, Math.floor(f0 / binHz));
    const b = Math.min(db.length - 1, Math.ceil(f1 / binHz));
    let p = 0; let n = 0;
    for (let i = a; i <= b; i += 1) {
      const v = db[i];
      p += Number.isFinite(v) ? 10 ** (v / 10) : 0;
      n += 1;
    }
    return n ? 10 * Math.log10(Math.max(p / n, 1e-16)) : -160;
  };
  const edges = cfg.HF_EDGES_HZ;
  const bands = [];
  for (let i = 0; i + 1 < edges.length; i += 1) bands.push(level(edges[i], edges[i + 1]));
  return {
    low: level(cfg.LOW_HZ[0], cfg.LOW_HZ[1]),
    bands,
    hf: level(edges[0], edges[edges.length - 1]),
  };
}

/**
 * Pure state machine for the spike decision. Feed it band levels with timestamps (ms):
 *   logic.push(t, { low, bands, hf }) -> event | null
 * An event is emitted when a burst has ENDED (so its length is known), but carries the time the
 * burst STARTED: { t, durMs, peakDb, riseDb, lowRiseDb, bandsHit }.
 */
export function createSpikeLogic(cfg = CONFIG.CHAIN) {
  let floors = null; // { low, bands[], hf } running noise floor in dB
  let lastT = null;
  let t0 = null; // first sample time (warm-up)
  let recent = []; // [t, hf] for the attack test
  let open = null; // burst in progress
  let ignoring = false; // a too-long burst (wind, speech): wait for quiet
  let quietSince = null;
  let live = { rise: 0, lowRise: 0, attack: 0, bandsHit: 0, floor: -120, state: 'warmup' };

  const follow = (floor, value, dt, tauUp, tauDown) => {
    const tau = value > floor ? tauUp : tauDown;
    return floor + (value - floor) * (1 - Math.exp(-dt / tau));
  };

  function push(t, lv) {
    if (floors === null) {
      floors = { low: lv.low, bands: [...lv.bands], hf: lv.hf };
      t0 = t;
    }
    const dt = lastT === null ? 0 : Math.min(Math.max(t - lastT, 1), 200);
    lastT = t;

    const fl = (v) => Math.max(v, cfg.MIN_FLOOR_DB);
    const rise = lv.hf - fl(floors.hf);
    const lowRise = lv.low - fl(floors.low);
    const bandRise = lv.bands.map((v, i) => v - fl(floors.bands[i]));
    const bandsHit = bandRise.filter((r) => r >= cfg.BAND_RISE_DB).length;

    recent.push([t, lv.hf]);
    while (recent.length && t - recent[0][0] > cfg.ATTACK_MS) recent.shift();
    const lowest = recent.length > 1
      ? Math.min(...recent.slice(0, -1).map((r) => r[1]))
      : lv.hf;
    const attack = lv.hf - lowest;

    live = { rise, lowRise, attack, bandsHit, floor: floors.hf, state: 'listening' };
    let event = null;
    const warm = t - t0 >= cfg.WARMUP_MS;
    if (!warm) live.state = 'warmup';

    if (open) {
      live.state = 'burst';
      if (lv.hf > open.peakDb) { open.peakDb = lv.hf; open.riseDb = rise; }
      if (lowRise > open.lowRiseDb) open.lowRiseDb = lowRise;
      if (bandsHit > open.bandsHit) open.bandsHit = bandsHit;
      if (rise >= cfg.END_DB) open.lastAbove = t;
      if (t - open.t > cfg.MAX_DUR_MS) {
        // Too long to be a chain rattle: drop it and wait for quiet.
        open = null;
        ignoring = true;
        quietSince = null;
      } else if (t - open.lastAbove >= cfg.HANG_MS) {
        const durMs = open.lastAbove - open.t + cfg.HANG_MS * 0.5;
        if (durMs >= cfg.MIN_DUR_MS && open.peakDb >= cfg.MIN_PEAK_DB) {
          event = {
            t: open.t,
            durMs,
            peakDb: open.peakDb,
            riseDb: open.riseDb,
            lowRiseDb: open.lowRiseDb,
            bandsHit: open.bandsHit,
          };
        }
        open = null;
      }
    } else if (ignoring) {
      live.state = 'ignoring';
      if (rise < cfg.END_DB) {
        if (quietSince === null) quietSince = t;
        if (t - quietSince >= cfg.HANG_MS) { ignoring = false; quietSince = null; }
      } else {
        quietSince = null;
      }
    } else if (
      warm
      && rise >= cfg.ONSET_DB
      && attack >= cfg.ATTACK_DB
      && bandsHit >= cfg.MIN_BANDS
      && lowRise - rise <= cfg.LOW_DOMINANCE_DB
    ) {
      open = {
        t, lastAbove: t, peakDb: lv.hf, riseDb: rise, lowRiseDb: lowRise, bandsHit,
      };
      live.state = 'burst';
    }

    // Noise floor: slow to rise, quicker to fall. Frozen during a burst so the burst itself
    // cannot raise it; after a long loud stretch (wind) it catches up quickly.
    if (!open) {
      const up = ignoring ? cfg.FLOOR_TAU_UP_FAST_MS : cfg.FLOOR_TAU_UP_MS;
      floors.hf = follow(floors.hf, lv.hf, dt, up, cfg.FLOOR_TAU_DOWN_MS);
      floors.low = follow(floors.low, lv.low, dt, up, cfg.FLOOR_TAU_DOWN_MS);
      floors.bands = floors.bands.map((f, i) => follow(f, lv.bands[i], dt, up, cfg.FLOOR_TAU_DOWN_MS));
    }
    return event;
  }

  return {
    push,
    getLive: () => ({ ...live }),
    reset() {
      floors = null; lastT = null; t0 = null; recent = []; open = null; ignoring = false;
      quietSince = null;
    },
  };
}

/**
 * createChainDetector({ onChain, onStatus })
 *   prepare()        call INSIDE the Start tap so Chrome lets the AudioContext run
 *   attach(stream)   the mic MediaStream from camera.js
 *   detach()
 *   onChain(ev)      ev = { t (performance.now() ms, burst start), durMs, peakDb, riseDb, lowRiseDb, bandsHit }
 *   onStatus(ok)     true while the context is running and the mic is delivering sound
 *   getInfo()        live levels for the debug view
 */
export function createChainDetector({ onChain, onStatus } = {}) {
  const C = CONFIG.CHAIN;
  const logic = createSpikeLogic(C);

  let ctx = null;
  let source = null;
  let analyser = null;
  let spectrum = null;
  let timer = 0;
  let ok = false;
  let deadSince = null;
  let polls = 0;
  let pollFps = 0;
  let fpsT = 0;
  let fpsN = 0;
  let levels = null;
  const events = [];

  function setOk(v) {
    if (v === ok) return;
    ok = v;
    if (onStatus) onStatus(ok);
  }

  function prepare() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC({ latencyHint: 'interactive' });
    ctx.addEventListener('statechange', () => { if (ctx && ctx.state !== 'running') setOk(false); });
    ctx.resume().catch(() => {});
  }

  function poll() {
    if (!analyser) return;
    const now = performance.now();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    analyser.getFloatFrequencyData(spectrum);
    const lv = bandsFromSpectrum(spectrum, ctx.sampleRate, C);
    levels = lv;
    polls += 1;
    fpsN += 1;
    if (now - fpsT >= 1000) { pollFps = (fpsN * 1000) / (now - fpsT); fpsN = 0; fpsT = now; }

    // A muted or dead mic gives digital silence: that is NO AUDIO, not a quiet room.
    if (lv.hf < C.DEAD_DB) {
      if (deadSince === null) deadSince = now;
    } else {
      deadSince = null;
    }
    setOk(ctx.state === 'running' && (deadSince === null || now - deadSince < C.DEAD_MS));

    const ev = logic.push(now, lv);
    if (ev) {
      events.push(ev);
      if (events.length > 20) events.shift();
      if (onChain) onChain(ev);
    }
  }

  async function attach(stream) {
    detach();
    prepare();
    if (!ctx) { setOk(false); return; }
    try { await ctx.resume(); } catch (_) { /* reported through setOk below */ }
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = C.FFT_SIZE;
    analyser.smoothingTimeConstant = 0; // no smoothing: onsets must stay sharp
    spectrum = new Float32Array(analyser.frequencyBinCount);
    source.connect(analyser); // not connected to the speakers
    logic.reset();
    deadSince = null;
    fpsT = performance.now();
    timer = setInterval(poll, C.POLL_MS);
    setOk(ctx.state === 'running');
  }

  function detach() {
    clearInterval(timer);
    timer = 0;
    if (source) { try { source.disconnect(); } catch (_) { /* ignore */ } }
    source = null;
    analyser = null;
    setOk(false);
  }

  return {
    prepare,
    attach,
    detach,
    /** Release the AudioContext too (end of session). */
    close() {
      detach();
      if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    },
    getInfo: () => ({
      ok,
      ctxState: ctx ? ctx.state : 'none',
      sampleRate: ctx ? ctx.sampleRate : null,
      pollFps,
      polls,
      levels,
      live: logic.getLive(),
      events: events.map((e) => ({ ...e })),
    }),
  };
}
