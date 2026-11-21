// outcome.js - basket location, chain-sound detection (Phase 5a), disc tracking and make/miss
// (Phase 5b).
//
//   1. createBasketFinder  finds the basket's box in the raw camera frame.
//   2. createChainDetector listens to the mic and emits an event for each chain-rattle burst.
//   3. createDiscWatcher   video -> small moving blobs inside a corridor around the putt line.
//   4. analyzeThrow        pure: blobs + chain events -> make / miss / ignored, with confidence.
//   5. createOutcomeJudge  queue of throws waiting for their result.
//   6. createOutcomeTracker wires 3 and 5 to the app (this is what main.js uses).
//
// The signal maths is in pure, DOM-free functions (findBasketCandidate, bandsFromSpectrum,
// createSpikeLogic, detectBlobs, analyzeThrow) so they can be tested without a browser.
// All numbers live in config.js.
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
 * Pure. Refine a tapped spot into the cage box: the top band and the tray are horizontal edges that
 * stand out from the same rows to the left and right, the chains between them are vertical edges.
 *   luma, w, h   grey crop;  tap { x, y } in crop pixels (the user's tap)
 *   frame        { w, h } size of the WHOLE frame in the same pixel scale (default: the crop is
 *                REFINE_CROP around the tap)
 * Returns { x0, y0, x1, y1, score, band, vEx } in crop pixels, or null. The caller decides with
 * band >= REFINE_BAND_MIN and score >= REFINE_MIN_SCORE whether it is trustworthy.
 */
export function refineBasketBox(luma, w, h, tap, cfg = CONFIG.BASKET, frame = null) {
  const edgeV = new Uint8Array(w * h);
  const edgeH = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const gx = Math.abs(luma[i + 1] - luma[i - 1]);
      const gy = Math.abs(luma[i + w] - luma[i - w]);
      if (gx >= cfg.REFINE_EDGE_MIN && gx >= cfg.VERT_RATIO * gy) edgeV[i] = 1;
      if (gy >= cfg.REFINE_EDGE_MIN && gy >= cfg.VERT_RATIO * gx) edgeH[i] = 1;
    }
  }
  const W1 = w + 1;
  const integ = (e) => {
    const ii = new Int32Array(W1 * (h + 1));
    for (let y = 0; y < h; y += 1) {
      let run = 0;
      for (let x = 0; x < w; x += 1) { run += e[y * w + x]; ii[(y + 1) * W1 + x + 1] = ii[y * W1 + x + 1] + run; }
    }
    return ii;
  };
  const iiV = integ(edgeV);
  const iiH = integ(edgeH);
  const dens = (ii, x0, y0, x1, y1) => {
    const a = Math.max(0, x0); const b = Math.min(w, x1);
    const c = Math.max(0, y0); const d = Math.min(h, y1);
    if (b <= a || d <= c) return 0;
    return (ii[d * W1 + b] - ii[c * W1 + b] - ii[d * W1 + a] + ii[c * W1 + a]) / ((x1 - x0) * (y1 - y0));
  };
  // The crop covers cfg.REFINE_CROP of the frame, so the search radii are scaled to crop pixels.
  const fw = frame ? frame.w : w / (2 * cfg.REFINE_CROP[0]);
  const frameH = frame ? frame.h : h / (2 * cfg.REFINE_CROP[1]);
  const rx = cfg.REFINE_RX * fw;
  const ry = cfg.REFINE_RY * frameH;
  let best = null;
  for (const frac of cfg.REFINE_H_FRACS) {
    for (const asp of cfg.REFINE_ASPECTS) {
      const bh = Math.round(frac * frameH);
      const bw = Math.round(bh * asp);
      const t = Math.max(2, Math.round(cfg.REFINE_BAND_FRAC * bh));
      for (let cx = tap.x - rx; cx <= tap.x + rx; cx += 2) {
        for (let cy = tap.y - ry; cy <= tap.y + ry; cy += 2) {
          const x0 = Math.round(cx - bw / 2); const y0 = Math.round(cy - bh / 2);
          const x1 = x0 + bw; const y1 = y0 + bh;
          const vin = dens(iiV, x0, y0, x1, y1);
          const vsur = Math.max(dens(iiV, x0 - bw, y0, x0, y1), dens(iiV, x1, y0, x1 + bw, y1));
          const top = dens(iiH, x0, y0 - t, x1, y0 + t);
          const bot = dens(iiH, x0, y1 - t, x1, y1 + t);
          const topS = Math.max(dens(iiH, x0 - bw, y0 - t, x0, y0 + t), dens(iiH, x1, y0 - t, x1 + bw, y0 + t));
          const botS = Math.max(dens(iiH, x0 - bw, y1 - t, x0, y1 + t), dens(iiH, x1, y1 - t, x1 + bw, y1 + t));
          const band = Math.min(top - topS, bot - botS);
          const dist = Math.hypot((cx - tap.x) / w, (cy - tap.y) / h);
          const score = cfg.REFINE_W_BAND * band + cfg.REFINE_W_V * (vin - vsur) - cfg.REFINE_W_DIST * dist;
          if (!best || score > best.score) best = { x0, y0, x1, y1, score, band, vEx: vin - vsur };
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
    /** Attach the video. The basket is normally marked by the user (mark / commit); with
     *  BASKET.AUTO_FIND (or after reset()) it also searches the whole frame by itself. */
    start(v, { auto = C.AUTO_FIND } = {}) {
      video = v; locked = null; hist = []; cand = null; stableCount = 0;
      if (auto) begin();
    },
    /**
     * The user tapped the basket (raw-frame fractions). Look around the tap for the top band and the
     * tray. Returns { xn, yn, wn, hn, refined, score, band }; refined = false means only the tap is
     * known (the box size is then taken from the scale later). Does not lock: call commit().
     */
    mark(xn, yn) {
      const plain = () => ({
        xn, yn, wn: null, hn: null, manual: true, refined: false, how: 'tap', score: null, band: null,
      });
      if (!video || video.readyState < 2 || !video.videoWidth) return plain();
      const vw = video.videoWidth; const vh = video.videoHeight;
      const [cwF, chF] = C.REFINE_CROP;
      const fx0 = Math.max(0, xn - cwF); const fx1 = Math.min(1, xn + cwF);
      const fy0 = Math.max(0, yn - chF); const fy1 = Math.min(1, yn + chF);
      const scale = Math.min(1, C.REFINE_W / vw);
      const w = Math.round((fx1 - fx0) * vw * scale);
      const h = Math.round((fy1 - fy0) * vh * scale);
      if (w < 40 || h < 40) return plain();
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      g.drawImage(video, fx0 * vw, fy0 * vh, (fx1 - fx0) * vw, (fy1 - fy0) * vh, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data;
      const luma = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < luma.length; i += 1, j += 4) luma[i] = (77 * px[j] + 150 * px[j + 1] + 29 * px[j + 2]) >> 8;
      const best = refineBasketBox(
        luma, w, h,
        { x: ((xn - fx0) / (fx1 - fx0)) * w, y: ((yn - fy0) / (fy1 - fy0)) * h },
        C, { w: w / (fx1 - fx0), h: h / (fy1 - fy0) },
      );
      if (!best || best.band < C.REFINE_BAND_MIN || best.score < C.REFINE_MIN_SCORE) return plain();
      // The tap was meant for the middle of the basket: a box that does not contain it is something else.
      const tx = ((xn - fx0) / (fx1 - fx0)) * w; const ty = ((yn - fy0) / (fy1 - fy0)) * h;
      if (tx < best.x0 || tx > best.x1 || ty < best.y0 || ty > best.y1) return plain();
      const bx = (px0) => fx0 + (px0 / w) * (fx1 - fx0);
      const by = (py0) => fy0 + (py0 / h) * (fy1 - fy0);
      return {
        xn: bx((best.x0 + best.x1) / 2),
        yn: by((best.y0 + best.y1) / 2),
        wn: ((best.x1 - best.x0) / w) * (fx1 - fx0),
        hn: ((best.y1 - best.y0) / h) * (fy1 - fy0),
        manual: true,
        refined: true,
        how: 'found',
        score: best.score,
        band: best.band,
      };
    },
    /** Lock the box the user confirmed. */
    commit(box) { accept({ ...box, manual: true }); },
    stop() { clearInterval(timer); timer = 0; video = null; },
    /** Forget the basket and search again. */
    reset() { locked = null; hist = []; cand = null; stableCount = 0; if (video) begin(); },
    /** Forget the basket without searching (the user will mark it again). */
    clear() { locked = null; clearInterval(timer); timer = 0; },
    /** Manual override (debug tap): accept this x (and y = cage centre) and stop searching. The
     *  box size is filled in later from the scale (createOutcomeTracker.setScene). */
    lock(xn, yn = null) {
      accept({ xn, yn, wn: null, hn: null, manual: true, refined: false, how: 'tap' });
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

// ===========================================================================================
// 3. DISC WATCHER  (video -> small moving blobs, Phase 5b)
//
// The disc is only ~15 px wide at the analysis width, so nothing clever is possible: a slow
// background model plus a frame difference, inside a corridor around the putt line, then connected
// components. A flying disc shows up as a small blob that also changed since the previous frame
// (move ~ 1); a resting disc is a small blob that did not (move ~ 0). Everything that decides what
// the blobs mean is in analyzeThrow (section 4), which is pure.
// The camera delivers 30 fps on the Pixel 6 Pro, so a putt is only a few dozen frames long.
// ===========================================================================================

let stackBuf = null;
let fgBuf = null;

/**
 * Pure. One analysis frame -> foreground blobs, and the background model is updated in place.
 *   luma, prev  Uint8 grey images (prev may be null on the first frame)
 *   bg          Float32Array background model, updated in place
 *   playerPx    { x0, x1, y0, y1 } in analysis pixels: foreground inside it is not counted in fgOut
 * Returns { blobs: [{ x, y, w, h, area, move }] (analysis px, largest first), fgOut (0-1) }.
 */
export function detectBlobs(luma, prev, bg, w, h, cfg = CONFIG.OUTCOME, playerPx = null, alpha = cfg.BG_ALPHA) {
  const n = w * h;
  if (!fgBuf || fgBuf.length !== n) fgBuf = new Uint8Array(n);
  const fg = fgBuf;
  fg.fill(0);
  const T = cfg.FG_THRESH;
  const MT = cfg.MOVE_THRESH;
  const a = alpha;
  let fgOut = 0;
  for (let i = 0; i < n; i += 1) {
    const l = luma[i];
    const d = l - bg[i];
    if (d > T || d < -T) {
      let m = 1;
      if (prev) {
        const e = l - prev[i];
        if (e > MT || e < -MT) m = 2;
      }
      fg[i] = m;
      if (playerPx) {
        const y = (i / w) | 0;
        const x = i - y * w;
        if (x < playerPx.x0 || x > playerPx.x1 || y < playerPx.y0 || y > playerPx.y1) fgOut += 1;
      } else {
        fgOut += 1;
      }
    }
    bg[i] += d * a;
  }

  if (!stackBuf || stackBuf.length < n) stackBuf = new Int32Array(n);
  const stack = stackBuf;
  const blobs = [];
  for (let s = 0; s < n; s += 1) {
    if (!fg[s]) continue;
    let sp = 0;
    stack[sp] = s * 2 + (fg[s] === 2 ? 1 : 0);
    sp += 1;
    fg[s] = 0;
    let area = 0; let mv = 0; let sx = 0; let sy = 0;
    let x0 = w; let x1 = -1; let y0 = h; let y1 = -1;
    while (sp > 0) {
      sp -= 1;
      const code = stack[sp];
      const i = code >> 1;
      mv += code & 1;
      const y = (i / w) | 0;
      const x = i - y * w;
      area += 1; sx += x; sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (fg[j]) {
            stack[sp] = j * 2 + (fg[j] === 2 ? 1 : 0);
            sp += 1;
            fg[j] = 0;
          }
        }
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (area < cfg.MIN_BLOB_PX || area > cfg.MAX_BLOB_PX) continue;
    if (bw > cfg.MAX_BLOB_DIM_PX || bh > cfg.MAX_BLOB_DIM_PX) continue;
    blobs.push({ x: sx / area + 0.5, y: sy / area + 0.5, w: bw, h: bh, area, move: mv / area });
  }
  blobs.sort((p, q) => q.area - p.area);
  if (blobs.length > cfg.MAX_BLOBS) blobs.length = cfg.MAX_BLOBS;
  return { blobs, fgOut: fgOut / n };
}

/** Pure. The corridor (raw-frame fractions) the disc can fly through: thrower to past the cage. */
export function corridorRoi(scene, cfg = CONFIG.OUTCOME) {
  const b = scene.box;
  const far = b.xn + scene.dir * b.wn * cfg.ROI_BEYOND_W;
  const near = scene.anchor.xn - scene.dir * cfg.ROI_BEHIND;
  const c = (v) => Math.min(Math.max(v, 0), 1);
  return {
    x0: c(Math.min(far, near)),
    x1: c(Math.max(far, near)),
    y0: c(b.yn - b.hn / 2 - cfg.ROI_UP_H * b.hn),
    y1: c(b.yn + b.hn / 2 + cfg.ROI_DOWN_H * b.hn),
  };
}

/** Padded bounding box (raw-frame fractions) of the visible pose landmarks, or null. */
export function playerBox(landmarks, padX = 0, padY = 0) {
  if (!landmarks) return null;
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const p of landmarks) {
    if ((p.visibility ?? 0) < 0.3) continue;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return x1 >= x0 ? { x0: x0 - padX, x1: x1 + padX, y0: y0 - padY, y1: y1 + padY } : null;
}

/** Pure. Where to read the corridor from the video and the size it is analysed at. */
export function analysisSize(vw, vh, roi, cfg = CONFIG.OUTCOME) {
  const s = Math.min(1, cfg.ANALYSIS_W / vw);
  const sx = roi.x0 * vw; const sy = roi.y0 * vh;
  const sw = (roi.x1 - roi.x0) * vw; const sh = (roi.y1 - roi.y0) * vh;
  return {
    sx, sy, sw, sh, w: Math.max(16, Math.round(sw * s)), h: Math.max(16, Math.round(sh * s)),
  };
}

/**
 * Pure-ish (keeps the background model). Turns RGBA pixels of the corridor into one frame record.
 * Used by the worker (disc-worker.js) and by the main-thread fallback.
 *   run(px, w, h, roi, player, t) -> { t, blobs (raw-frame fractions), fgOut, dropped, warm, player }
 */
export function createFrameAnalyzer(cfg = CONFIG.OUTCOME) {
  let bg = null; let prev = null; let luma = null;
  let cw = 0; let ch = 0; let frameNo = 0; let lastT = null;
  return {
    reset() { bg = null; prev = null; frameNo = 0; lastT = null; },
    run(px, w, h, roi, player, t) {
      if (!bg || w !== cw || h !== ch) {
        cw = w; ch = h;
        bg = new Float32Array(w * h); luma = new Uint8Array(w * h); prev = null; frameNo = 0; lastT = null;
      }
      for (let i = 0, j = 0; i < luma.length; i += 1, j += 4) {
        luma[i] = (77 * px[j] + 150 * px[j + 1] + 29 * px[j + 2]) >> 8;
      }
      if (frameNo === 0) for (let i = 0; i < luma.length; i += 1) bg[i] = luma[i];
      const dtS = lastT == null ? 0.033 : Math.max(0.001, (t - lastT) / 1000);
      const alpha = 1 - Math.exp(-dtS / cfg.BG_TAU_S); // the background follows at a fixed speed in seconds, whatever the frame rate
      const rw = roi.x1 - roi.x0; const rh = roi.y1 - roi.y0;
      const pp = player
        ? {
          x0: ((player.x0 - roi.x0) / rw) * w,
          x1: ((player.x1 - roi.x0) / rw) * w,
          y0: ((player.y0 - roi.y0) / rh) * h,
          y1: ((player.y1 - roi.y0) / rh) * h,
        }
        : null;
      const res = detectBlobs(luma, prev, bg, w, h, cfg, pp, alpha);
      if (!prev) prev = new Uint8Array(w * h);
      prev.set(luma);
      frameNo += 1;
      const dropped = lastT == null ? 0 : Math.max(0, Math.round((t - lastT) / 33.3) - 1);
      lastT = t;
      return {
        t,
        blobs: res.blobs.map((b) => ({
          x: roi.x0 + (b.x / w) * rw,
          y: roi.y0 + (b.y / h) * rh,
          w: (b.w / w) * rw,
          h: (b.h / h) * rh,
          area: b.area,
          move: b.move,
        })),
        fgOut: res.fgOut,
        dropped,
        warm: frameNo <= cfg.WARMUP_FRAMES,
        player: player ? { ...player } : null,
      };
    },
  };
}

/**
 * createDiscWatcher({ video, track, onFrame })
 *   With a video `track` and a browser that has MediaStreamTrackProcessor + module workers, the frames
 *   are analysed in disc-worker.js, off the main thread (pose tracking keeps the main thread busy, and
 *   on the main thread the analysis only got about 6 frames a second). Otherwise it falls back to
 *   requestVideoFrameCallback on the main thread.
 *   start() / stop()    setRoi(roi|null)  corridor in raw-frame fractions; null pauses
 *   setPlayer(box|null) padded body box (raw-frame fractions) kept out of the noise measure
 *   reset()             forget the background model
 *   onFrame({ t, blobs, fgOut, dropped, warm, player }) t in performance.now() ms
 */
export function createDiscWatcher({ video, track = null, onFrame } = {}) {
  const C = CONFIG.OUTCOME;
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const analyzer = createFrameAnalyzer(C);

  let roi = null;
  let player = null;
  let running = false;
  let handle = 0;
  let rvfc = false;
  let worker = null;
  let mode = 'idle';
  let workerInfo = { fps: 0, ms: 0, frames: 0, fgOut: 0, w: 0, h: 0 };
  let msAvg = 0; let fps = 0; let fpsN = 0; let fpsT = 0; let total = 0; let lastFg = 0; let cw = 0; let ch = 0;

  function reset() {
    analyzer.reset();
    if (worker) worker.postMessage({ type: 'reset' });
  }

  function setRoi(r) {
    const same = (!roi && !r) || (roi && r
      && Math.abs(roi.x0 - r.x0) < 0.004 && Math.abs(roi.x1 - r.x1) < 0.004
      && Math.abs(roi.y0 - r.y0) < 0.004 && Math.abs(roi.y1 - r.y1) < 0.004);
    if (same) return;
    roi = r ? { ...r } : null;
    analyzer.reset();
    if (worker) worker.postMessage({ type: 'roi', roi });
  }

  function setPlayer(b) {
    player = b;
    if (worker) worker.postMessage({ type: 'player', player: b });
  }

  // ---- main-thread fallback -----------------------------------------------------------------
  function tick(now, meta) {
    if (!running || mode !== 'main') return;
    schedule();
    if (!roi || !video || video.readyState < 2 || !video.videoWidth) return;
    const t0 = performance.now();
    const z = analysisSize(video.videoWidth, video.videoHeight, roi, C);
    if (canvas.width !== z.w || canvas.height !== z.h) { canvas.width = z.w; canvas.height = z.h; }
    cw = z.w; ch = z.h;
    g.drawImage(video, z.sx, z.sy, z.sw, z.sh, 0, 0, z.w, z.h);
    const px = g.getImageData(0, 0, z.w, z.h).data;
    const f = analyzer.run(px, z.w, z.h, roi, player, meta && meta.captureTime ? meta.captureTime : now);
    lastFg = f.fgOut;
    const ms = performance.now() - t0;
    msAvg = msAvg ? 0.9 * msAvg + 0.1 * ms : ms;
    total += 1; fpsN += 1;
    if (now - fpsT >= 1000) { fps = (fpsN * 1000) / (now - fpsT); fpsN = 0; fpsT = now; }
    f.ms = ms;
    if (onFrame) onFrame(f);
  }

  function schedule() {
    if (rvfc) handle = video.requestVideoFrameCallback(tick);
  }

  function startMain() {
    mode = 'main';
    rvfc = 'requestVideoFrameCallback' in video;
    if (rvfc) schedule(); else handle = setInterval(() => tick(performance.now(), null), 33);
  }

  // ---- worker ---------------------------------------------------------------------------------
  function startWorker() {
    try {
      const processor = new MediaStreamTrackProcessor({ track });
      worker = new Worker(new URL('./disc-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'frame') { total += 1; lastFg = m.f.fgOut; if (onFrame) onFrame(m.f); } else if (m.type === 'info') workerInfo = m.info;
        else if (m.type === 'error') { console.warn('disc worker:', m.message); fallBack(); }
      };
      worker.onerror = (e) => { console.warn('disc worker failed', e.message); fallBack(); };
      worker.postMessage({
        type: 'init', readable: processor.readable, timeOrigin: performance.timeOrigin, roi, player,
      }, [processor.readable]);
      mode = 'worker';
    } catch (err) {
      console.warn('disc worker unavailable:', err);
      worker = null;
      startMain();
    }
  }

  function fallBack() {
    if (worker) { worker.terminate(); worker = null; }
    if (running && mode !== 'main') startMain();
  }

  return {
    start() {
      if (running) return;
      running = true;
      const canWorker = track && typeof MediaStreamTrackProcessor !== 'undefined' && typeof Worker !== 'undefined';
      if (canWorker) startWorker(); else if (video) startMain();
    },
    stop() {
      running = false;
      if (worker) { worker.postMessage({ type: 'stop' }); worker.terminate(); worker = null; }
      if (rvfc) { try { video.cancelVideoFrameCallback(handle); } catch (_) { /* ignore */ } } else clearInterval(handle);
      handle = 0; mode = 'idle';
    },
    setRoi,
    setPlayer,
    reset,
    getInfo: () => (mode === 'worker'
      ? {
        running, mode, roi: roi ? { ...roi } : null, w: workerInfo.w, h: workerInfo.h, ms: workerInfo.ms, fps: workerInfo.fps, frames: total, fgOut: lastFg,
      }
      : {
        running, mode, roi: roi ? { ...roi } : null, w: cw, h: ch, ms: msAvg, fps, frames: total, fgOut: lastFg,
      }),
  };
}

// ===========================================================================================
// 4. MAKE / MISS ANALYSIS  (pure; no DOM, no timers)
//
// Coordinates: u = distance along the putt line from the cage centre, in cage widths (negative =
// short of the basket); v = offset from the cage centre in cage heights (positive = down).
// Evidence, in the order it is used:
//   flight track  a ballistic chain of moving blobs that starts at the hand and heads for the cage
//   pass          the track carries on beyond the cage             -> MISS (long)
//   rest          a NEW still blob (a landed disc) outside the cage -> MISS (short / long)
//   exit          a moving track leaving the cage after contact    -> MISS (bounce / drop out)
//   make          track reached the cage, chain sound at contact, then SETTLE_MS with the video
//                 healthy, no exit, no resting disc outside the cage
// Anything else is IGNORED. The chain sound alone never scores, and a make needs both the
// flight and the sound.
// ===========================================================================================

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const inBox = (p, bx) => !!bx && p.x >= bx.x0 && p.x <= bx.x1 && p.y >= bx.y0 && p.y <= bx.y1;
const median2 = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pure. null if the basket box and scale can be trusted, else a short reason. */
export function checkScene(scene, cfg = CONFIG.OUTCOME) {
  if (!scene || !scene.box) return 'no basket box';
  const b = scene.box;
  if (b.yn == null || b.wn == null || b.hn == null) return 'basket box unknown (manual tap)';
  if (!scene.anchor || !scene.ftPerNormX || !scene.aspect) return 'no scale';
  const wFt = b.wn * scene.ftPerNormX;
  const hFt = (b.hn * scene.ftPerNormX) / scene.aspect;
  if (wFt < cfg.BOX_FT[0] || wFt > cfg.BOX_FT[1] || hFt < cfg.BOX_FT[0] || hFt > cfg.BOX_FT[1]) {
    return `basket box implausible (${wFt.toFixed(1)} x ${hFt.toFixed(1)} ft)`;
  }
  const d = scene.anchor.distanceFt;
  if (d == null || d < cfg.ANCHOR_FT[0] || d > cfg.ANCHOR_FT[1]) {
    return `basket distance implausible (${d == null ? '--' : d.toFixed(0)} ft)`;
  }
  return null;
}

/** Least-squares fit of a ballistic path to track points (feet). */
function fitTrack(pts, cfg) {
  const n = pts.length;
  const t0 = pts[0].t;
  const s = pts.map((p) => (p.t - t0) / 1000);
  const lin = (ys) => {
    const sm = s.reduce((a, v) => a + v, 0) / n;
    const ym = ys.reduce((a, v) => a + v, 0) / n;
    let num = 0; let den = 0;
    for (let i = 0; i < n; i += 1) { num += (s[i] - sm) * (ys[i] - ym); den += (s[i] - sm) ** 2; }
    const b = den > 1e-9 ? num / den : 0;
    return { a: ym - b * sm, b };
  };
  const fx = lin(pts.map((p) => p.fx));
  const fy = lin(pts.map((p, i) => p.fy - 0.5 * cfg.G_FTS2 * s[i] * s[i]));
  let ss = 0;
  for (let i = 0; i < n; i += 1) {
    ss += (pts[i].fx - (fx.a + fx.b * s[i])) ** 2
      + (pts[i].fy - (fy.a + fy.b * s[i] + 0.5 * cfg.G_FTS2 * s[i] * s[i])) ** 2;
  }
  return { t0, x0: fx.a, vx: fx.b, y0: fy.a, vy: fy.b, rms: Math.sqrt(ss / n) };
}

/** Greedy extension of a seed pair along a ballistic prediction. */
function growTrack(cf, j0, pts, vx0, vy0, cfg) {
  let last = pts[pts.length - 1];
  let vx = vx0;
  let vy = vy0;
  for (let k = j0 + 1; k < cf.length; k += 1) {
    const dtMs = cf[k].t - last.t;
    if (dtMs <= 0) continue;
    if (dtMs > cfg.MAX_GAP_MS) break;
    const dt = dtMs / 1000;
    const px = last.fx + vx * dt;
    const py = last.fy + vy * dt + 0.5 * cfg.G_FTS2 * dt * dt;
    let hit = null;
    let bd = cfg.GATE_FT + cfg.GATE_PER_S * dt;
    for (const c of cf[k].c) {
      const d = Math.hypot(c.fx - px, c.fy - py);
      if (d < bd) { bd = d; hit = c; }
    }
    if (hit) {
      vx = 0.5 * vx + 0.5 * ((hit.fx - last.fx) / dt);
      vy = 0.5 * vy + 0.5 * ((hit.fy - last.fy) / dt + 0.5 * cfg.G_FTS2 * dt);
      pts.push(hit);
      last = hit;
    }
  }
  return pts;
}

/**
 * Best ballistic track among seeds. cf = [{ t, c: [blob] }] by time. isSeed(blob), velOk(vx, vy).
 * Returns { pts, fit, n, score } or null.
 */
function searchTrack(cf, isSeed, velOk, minPts, cfg) {
  let best = null;
  for (let i = 0; i < cf.length; i += 1) {
    for (const a of cf[i].c) {
      if (!isSeed(a)) continue;
      for (let j = i + 1; j < cf.length && cf[j].t - a.t <= cfg.MAX_GAP_MS; j += 1) {
        for (const b of cf[j].c) {
          const dt = (b.t - a.t) / 1000;
          if (dt <= 0) continue;
          const vx = (b.fx - a.fx) / dt;
          const vy = (b.fy - a.fy) / dt;
          if (!velOk(vx, vy)) continue;
          const pts = growTrack(cf, j, [a, b], vx, vy + 0.5 * cfg.G_FTS2 * dt, cfg);
          let fit = fitTrack(pts, cfg);
          while (pts.length > minPts && fit.rms > cfg.MAX_TRACK_RMS_FT) {
            pts.pop();
            fit = fitTrack(pts, cfg);
          }
          if (pts.length < minPts || fit.rms > cfg.MAX_TRACK_RMS_FT) continue;
          const score = pts.length - 2 * fit.rms;
          if (!best || score > best.score) best = { pts, fit, n: pts.length, score };
        }
      }
    }
  }
  return best;
}

/** Still blobs that persist for REST_FRAMES: a landed or dropped disc. Clusters in feet. */
function findRestClusters(fr, cfg) {
  const clusters = [];
  for (const f of fr) {
    const used = new Set();
    for (const b of f.blobs) {
      if (b.body || b.move > cfg.REST_MOVE_MAX) continue;
      let c = null;
      for (const k of clusters) {
        if (!used.has(k) && Math.hypot(b.fx - k.fx, b.fy - k.fy) <= cfg.REST_RADIUS_FT) { c = k; break; }
      }
      if (c) {
        c.fx = (c.fx * c.count + b.fx) / (c.count + 1);
        c.fy = (c.fy * c.count + b.fy) / (c.count + 1);
        c.u = (c.u * c.count + b.u) / (c.count + 1);
        c.v = (c.v * c.count + b.v) / (c.count + 1);
        c.count += 1;
        c.lastT = f.t;
        used.add(c);
      } else {
        const k = { fx: b.fx, fy: b.fy, u: b.u, v: b.v, count: 1, firstT: f.t, lastT: f.t };
        clusters.push(k);
        used.add(k);
      }
    }
  }
  return clusters;
}

/**
 * Pure. Judge one throw from what the camera and microphone saw.
 *   ctx = { thr, scene, frames, chains, now, final, endT }
 *     thr     { t (release, perf ms), release: { xn, yn }|null, distanceFt }
 *     scene   { box, dir, anchor, ftPerNormX, aspect }
 *     frames  watcher frames; chains  chain events; now  current time (ms)
 *     final   true when no more waiting is allowed (decide or ignore now)
 *     endT    frames after this belong to the next throw
 * Returns { state: 'wait' } or
 *   { state: 'done', result: 'make'|'miss'|'ignored', missDirection, reason, conf, ev }
 * ev holds every number behind the call, for the debug log.
 *
 * Evidence (u, v = position in cage widths / heights from the cage centre):
 *   flight   a ballistic chain of moving blobs (the release time is only a rough guide: the wrist's
 *            peak speed comes up to ~0.5 s before the disc leaves the hand on a slow putt)
 *   entry    a moving blob inside the cage zone after the release (with no flight track, e.g. when
 *            frames were too sparse to follow the disc, this is the arrival)
 *   stay     a NEW still blob inside the cage, linked to this throw's final tracked position
 *   rest     a NEW still blob outside the cage: a landed or dropped disc
 *   exit     a moving track leaving the cage after contact
 *   chain    the chain sound at contact (supporting only: a cage hit makes it too)
 * MISS: flew past, or rest outside, or exit.  MAKE: arrival, then (stay or chain), then SETTLE_MS of
 * healthy video with no exit and no rest outside. Existing stationary basket discs are not
 * positive evidence for a new make. Anything else is IGNORED.
 */
export function analyzeThrow(ctx, cfg = CONFIG.OUTCOME) {
  const {
    thr, scene, frames, chains, now, final, endT = Infinity,
  } = ctx;
  const ev = { factors: {} };
  const ignore = (reason) => ({
    state: 'done', result: 'ignored', missDirection: null, reason, conf: 0, ev,
  });
  const wait = () => ({ state: 'wait', ev });

  const gate = checkScene(scene, cfg);
  if (gate) { ev.gate = gate; return ignore(gate); }
  const S = scene.ftPerNormX;
  const A = scene.aspect;
  const b = scene.box;
  const dir = scene.dir;

  // ---- Frames, in feet and cage units ------------------------------------------------------
  const fr = [];
  for (const f of frames) {
    if (f.warm || f.t < thr.t - cfg.PRE_MS - 1500 || f.t > endT) continue;
    fr.push({
      t: f.t,
      fgOut: f.fgOut,
      blobs: f.blobs.map((q) => ({
        t: f.t,
        x: q.x,
        y: q.y,
        area: q.area,
        move: q.move,
        fx: q.x * S,
        fy: (q.y * S) / A,
        u: (dir * (q.x - b.xn)) / b.wn,
        v: (q.y - b.yn) / b.hn,
        body: inBox(q, f.player),
        early: f.t - thr.t <= cfg.PLAYER_FREE_MS,
      })),
    });
  }
  const post = fr.filter((f) => f.t >= thr.t - cfg.PRE_MS);
  ev.frames = post.length;
  if (post.length < 3) {
    if (final || now > thr.t + cfg.FLIGHT_WAIT_MS) return ignore('no video frames');
    return wait();
  }
  const lastFrameT = post[post.length - 1].t;
  const inZone = (q, zu, zv) => Math.abs(q.u) <= zu && Math.abs(q.v) <= zv;

  // ---- Flight track (may not exist) ----------------------------------------------------------
  const hand = thr.release ? { fx: thr.release.xn * S, fy: (thr.release.yn * S) / A } : null;
  const cand = post.map((f) => ({
    t: f.t,
    c: f.blobs.filter((q) => q.move >= cfg.MIN_MOVE && (!q.body || q.early)),
  }));
  const seedOk = (q) => q.t >= thr.t - cfg.PRE_MS && q.t <= thr.t + cfg.START_WINDOW_MS
    && (!hand || Math.hypot(q.fx - hand.fx, q.fy - hand.fy) <= cfg.START_RADIUS_FT);
  const velOk = (vx, vy) => dir * vx >= cfg.VX_MIN_FTS && Math.hypot(vx, vy) <= cfg.V_MAX_FTS;
  const trk = searchTrack(cand, seedOk, velOk, cfg.MIN_TRACK_PTS, cfg);
  let fTrack = 0;
  let last = null;
  let fDensity = 1;
  let arr = null;
  let passPts = 0;
  if (trk) {
    const pts = trk.pts;
    last = pts[pts.length - 1];
    const fitq = clamp01((cfg.MAX_TRACK_RMS_FT - trk.fit.rms) / (cfg.MAX_TRACK_RMS_FT * 0.5));
    // How often the disc was seen along its flight. If it was often missed in flight it could have
    // been missed leaving the cage too, so "nothing left" proves little.
    const spanFrames = post.filter((f) => f.t >= pts[0].t && f.t <= last.t).length;
    const density = spanFrames > 0 ? trk.n / spanFrames : 0;
    fDensity = clamp01((density - cfg.DENSITY_MIN) / (cfg.DENSITY_FULL - cfg.DENSITY_MIN));
    fTrack = Math.min(clamp01((trk.n - 1) / 3), fitq);
    ev.trk = {
      n: trk.n, density, rms: trk.fit.rms, vxFts: dir * trk.fit.vx, t0: pts[0].t, tLast: last.t,
      uFirst: pts[0].u, uLast: last.u, vLast: last.v,
      pts: pts.map((p) => [p.x, p.y, p.t]),
    };
    ev.factors.track = fTrack;
    for (const p of pts) {
      if (inZone(p, cfg.ARRIVE_U, cfg.ARRIVE_V)) { arr = { t: p.t, u: p.u, v: p.v, inferred: false }; break; }
    }
    if (!arr && cfg.ALLOW_INFERRED_ARRIVAL && last.u >= -cfg.INFER_U && last.u < -cfg.ARRIVE_U) {
      // Disc lost just short of the cage: project the fit to the cage's near edge.
      const xFront = (b.xn - dir * 0.5 * b.wn) * S;
      const s = (xFront - trk.fit.x0) / trk.fit.vx;
      if (Number.isFinite(s) && s >= 0) {
        const yFt = trk.fit.y0 + trk.fit.vy * s + 0.5 * cfg.G_FTS2 * s * s;
        const v = ((yFt * A) / S - b.yn) / b.hn;
        if (Math.abs(v) <= cfg.ARRIVE_V) arr = { t: trk.fit.t0 + s * 1000, u: -0.5, v, inferred: true };
      }
    }
    passPts = pts.filter((p) => p.u >= cfg.PASS_U).length;
  }
  ev.passPts = passPts;

  // ---- Cage entry without a track (frames too sparse to follow the disc) -----------------------
  let trackless = false;
  if (!arr && cfg.ALLOW_TRACKLESS) {
    const pre = fr.filter((f) => f.t >= thr.t - 1500 && f.t < thr.t - 200);
    const noisyBase = pre.length >= 4
      && pre.filter((f) => f.blobs.some((q) => !q.body && q.move >= cfg.MIN_MOVE && inZone(q, cfg.ARRIVE_U, cfg.ARRIVE_V))).length / pre.length > cfg.EXIT_BASE_MAX;
    if (!noisyBase) {
      let entry = null;
      for (const f of post) {
        if (f.t < thr.t) continue;
        const q = f.blobs.find((x) => !x.body && x.move >= cfg.MIN_MOVE && inZone(x, cfg.ARRIVE_U, cfg.ARRIVE_V));
        if (q) { entry = { t: f.t, u: q.u, v: q.v, inferred: true }; break; }
      }
      if (entry) { arr = entry; trackless = true; fTrack = cfg.TRACKLESS_CONF; }
    }
  }
  ev.arr = arr;
  ev.trackless = trackless;

  const missResult = (direction, reason, conf, extra) => {
    ev.factors.final = conf;
    if (conf < cfg.CONF_MIN_MISS) return ignore(`low confidence (${reason})`);
    return {
      state: 'done', result: 'miss', missDirection: direction, reason, conf, ev, ...extra,
    };
  };
  const dirOf = (u, v) => (u < -0.5 ? 'short' : u > 0.5 ? 'long' : v > cfg.REST_OUT_V ? 'short' : null);

  // A disc observed below the basket's lower edge while horizontally crossing the cage
  // has passed underneath it. Require two tracked observations to reject one-frame noise.
  if (trk) {
    const below = trk.pts.filter((p) => Math.abs(p.u) <= 1.2 && p.v > 0.65);
    if (below.length >= 2) {
      ev.belowBasket = below.map((p) => ({ u: p.u, v: p.v, t: p.t }));
      return missResult('short', 'passed below basket', Math.max(fTrack, 0.8));
    }
  }

  // 1. The disc flew on past the cage.
  if (passPts >= 2) {
    const fPass = clamp01(passPts / 3);
    ev.factors.pass = fPass;
    // A consistent set of detections beyond the cage is direct miss evidence. Do not let a
    // mediocre whole-flight fit erase that independent evidence.
    return missResult('long', 'flew past', Math.max(fTrack, fPass * cfg.PASS_TRACK_CONF));
  }

  // 2. Still blobs after release. A resting blob may support THIS make only when it is
  // spatially linked to this throw's final moving track and was not already present before
  // release. A stationary disc elsewhere in a basket containing earlier putts is not evidence.
  const allRest = findRestClusters(fr.filter((f) => f.t >= thr.t - 600), cfg)
    .filter((k) => k.firstT > thr.t + 100 && k.count >= cfg.REST_MIN_FRAMES && k.lastT - k.firstT >= cfg.REST_MIN_MS)
    .filter((k) => (last
      ? Math.hypot(k.fx - last.fx, k.fy - last.fy) <= cfg.REST_NEAR_TRACK_FT
      : Math.abs(k.u) <= cfg.TRACKLESS_MAX_U && Math.abs(k.v) <= cfg.TRACKLESS_MAX_U));

  // Build a small map of stationary objects visible in multiple pre-release frames.
  const preStill = [];
  const baselineFrames = fr.filter((f) => f.t >= thr.t - 1500 && f.t < thr.t - 200);
  for (const f of baselineFrames) {
    for (const q of f.blobs) {
      if (q.body || q.move > cfg.REST_MOVE_MAX) continue;
      let k = preStill.find((x) => Math.hypot(q.fx - x.fx, q.fy - x.fy) <= cfg.REST_RADIUS_FT);
      if (!k) { k = { fx: q.fx, fy: q.fy, count: 0, lastT: -Infinity }; preStill.push(k); }
      // Count distinct frames, not multiple fragments of the same object in one frame.
      if (k.lastT !== f.t) {
        k.fx = (k.fx * k.count + q.fx) / (k.count + 1);
        k.fy = (k.fy * k.count + q.fy) / (k.count + 1);
        k.count += 1;
        k.lastT = f.t;
      }
    }
  }
  const wasAlreadyThere = (k) => preStill.some((p) => p.count >= 2
    && Math.hypot(k.fx - p.fx, k.fy - p.fy) <= cfg.STAY_PREEXIST_RADIUS_FT);
  const inCore = (k) => Math.abs(k.u) <= cfg.CORE_U && Math.abs(k.v) <= cfg.CORE_V;
  const outside = (k) => Math.abs(k.u) > cfg.REST_OUT_U || Math.abs(k.v) > cfg.REST_OUT_V;
  const byCount = (p, q) => q.count - p.count;
  const restCandidates = allRest.filter((k) => !wasAlreadyThere(k));
  const restOut = restCandidates.filter(outside).sort(byCount)[0] || null;

  // Only call a cluster a current-throw stay if the moving track ended in the arrival zone
  // and the new still blob is close in both space and time.
  const linkedStayCandidates = last && inZone(last, cfg.ARRIVE_U, cfg.ARRIVE_V)
    ? restCandidates.filter((k) => inCore(k)
      && Math.hypot(k.fx - last.fx, k.fy - last.fy) <= cfg.STAY_LINK_MAX_FT
      && k.firstT >= last.t - 150
      && k.firstT <= last.t + cfg.STAY_LINK_MAX_MS)
    : [];
  const stay = linkedStayCandidates.sort(byCount)[0] || null;
  const restBand = restCandidates.some((k) => !inCore(k) && !outside(k));
  ev.rest = restOut ? { u: restOut.u, v: restOut.v, count: restOut.count } : null;
  ev.stay = stay ? { u: stay.u, v: stay.v, count: stay.count, firstT: stay.firstT, lastT: stay.lastT } : null;
  ev.restBand = restBand;
  if (restOut && (trk || trackless || cfg.ALLOW_TRACKLESS)) {
    const fRest = clamp01(restOut.count / (cfg.REST_MIN_FRAMES * 1.6));
    ev.factors.rest = fRest;
    const base = trk || trackless ? fTrack : cfg.TRACKLESS_CONF;
    return missResult(dirOf(restOut.u, restOut.v), 'disc landed outside', Math.min(base, fRest));
  }

  // 3. Arrival at the cage.
  if (!arr) {
    if (!trk) {
      if (final || now > thr.t + cfg.FLIGHT_WAIT_MS) return ignore('no flight track');
      return wait();
    }
    if (!final && now - last.t < cfg.TRACK_LOST_MS && now < thr.t + cfg.HORIZON_MS) return wait();
    return ignore('track lost before the basket');
  }

  // 3b. Moving blobs beyond the cage after the arrival: the disc went through / past, not in.
  const bcf = post.filter((f) => f.t > arr.t).map((f) => ({
    t: f.t,
    c: f.blobs.filter((q) => !q.body && q.move >= cfg.MIN_MOVE && q.u >= cfg.PASS_U && q.u <= cfg.BEYOND_MAX_U && Math.abs(q.v) <= 2.5),
  }));
  const beyondTrk = searchTrack(bcf, () => true, velOk, 3, cfg);
  ev.beyond = beyondTrk ? beyondTrk.n : 0;
  if (beyondTrk) {
    const fB = clamp01(beyondTrk.n / 4);
    ev.factors.pass = fB;
    // The post-arrival beyond-cage track is independent evidence of a long miss;
    // a weak fit to the earlier flight should not collapse its confidence to near zero.
    return missResult('long', 'went past the basket', Math.max(fTrack || cfg.TRACKLESS_CONF, fB * cfg.PASS_TRACK_CONF));
  }

  // 4. Contact: chain sound (supporting) and/or a disc that stays.
  const chainHits = chains
    .filter((e) => e.t >= arr.t + cfg.AUDIO_MATCH_MS[0] && e.t <= arr.t + cfg.AUDIO_MATCH_MS[1])
    .sort((p, q) => p.t - q.t);
  const cm = chainHits[0] || null;
  ev.chain = cm ? { dtMs: cm.t - arr.t, riseDb: cm.riseDb, bands: cm.bandsHit, durMs: cm.durMs } : null;
  // A resting disc must still be there, or have been there for about the settle time; a short-lived
  // cluster (chains swaying) is not evidence.
  const stayOk = !!stay && !trackless && stay.firstT >= arr.t - 300
    && (stay.lastT - stay.firstT >= cfg.SETTLE_MS - 250 || stay.lastT >= lastFrameT - 300);
  let contactT = arr.t;
  if (cm) { // a second clank soon after the first pushes the call back
    let lastC = cm.t;
    for (const e of chains.filter((x) => x.t > cm.t).sort((p, q) => p.t - q.t)) {
      if (e.t - lastC <= cfg.SETTLE_MS) lastC = e.t;
    }
    contactT = lastC;
  } else if (stayOk) {
    contactT = stay.firstT;
  }
  const decideAt = contactT + cfg.SETTLE_MS;
  ev.contactT = contactT;
  ev.decideAt = decideAt;

  // 5. The disc left the cage again (bounce out, drop out): a moving track outside the cage zone.
  const exitFrames = post.filter((f) => f.t > (cm ? cm.t : arr.t) + cfg.EXIT_GRACE_MS);
  const exitBlobs = (f) => f.blobs.filter((q) => !q.body && q.move >= cfg.MIN_MOVE
    && (Math.abs(q.u) > cfg.EXIT_U || Math.abs(q.v) > cfg.EXIT_V)
    && Math.abs(q.u) <= cfg.EXIT_MAX_U && q.v >= cfg.EXIT_V_RANGE[0] && q.v <= cfg.EXIT_V_RANGE[1]);
  const ecf = exitFrames.map((f) => ({ t: f.t, c: exitBlobs(f) }));
  const exitTrk = searchTrack(ecf, () => true, (vx, vy) => Math.hypot(vx, vy) >= 3 && Math.hypot(vx, vy) <= cfg.V_MAX_FTS,
    cfg.EXIT_MIN_PTS, cfg);
  ev.exit = exitTrk ? { n: exitTrk.n, uEnd: exitTrk.pts[exitTrk.n - 1].u } : null;
  if (exitTrk) {
    const fExit = clamp01((exitTrk.n - 1) / 3);
    ev.factors.exit = fExit;
    const e = exitTrk.pts[exitTrk.n - 1];
    return missResult(dirOf(e.u, e.v), 'left the basket', Math.min(fTrack || cfg.TRACKLESS_CONF, fExit), { arrived: true });
  }
  const weakFrames = ecf.filter((f) => f.t <= decideAt && f.c.length > 0).length;
  ev.exitWeakFrames = weakFrames;

  // Baseline: how often the exit zone shows moving blobs when nothing is thrown (wind, leaves).
  const preQuiet = fr.filter((f) => f.t >= thr.t - 1500 && f.t < thr.t - 300);
  const baseFrac = preQuiet.length >= 5 ? preQuiet.filter((f) => exitBlobs(f).length > 0).length / preQuiet.length : 0;
  ev.baseFrac = baseFrac;

  // 6. A make needs a chain sound or a disc that stays, a quiet settle window, and healthy video.
  const silent = !cm && !stayOk;
  if (silent) {
    if (!final && now < arr.t + cfg.AUDIO_MATCH_MS[1] + cfg.AUDIO_LATE_MS) return wait();
    if (!cfg.ALLOW_SILENT_MAKE) return ignore('contact without chain sound or a resting disc');
  }
  if (now < decideAt && !final) return wait();
  if (!cm && stayOk && stay.lastT < decideAt - 250) {
    return final || now > decideAt + 1500 ? ignore('disc did not stay') : wait();
  }
  if (lastFrameT < decideAt - 100) {
    return final || now > decideAt + 1500 ? ignore('video stalled after contact') : wait();
  }
  if (final && now < decideAt) return ignore('cut short by the next throw');

  const win = post.filter((f) => f.t >= contactT && f.t <= decideAt);
  const fps = (win.length * 1000) / cfg.SETTLE_MS;
  let maxGap = 0;
  let prevT = contactT;
  for (const f of win) { maxGap = Math.max(maxGap, f.t - prevT); prevT = f.t; }
  maxGap = Math.max(maxGap, decideAt - prevT);
  ev.cover = { fps, maxGapMs: maxGap };
  if (fps < cfg.MIN_FPS || maxGap > cfg.MAX_GAP_SETTLE_MS) return ignore('video too sparse after contact');
  if (baseFrac > cfg.EXIT_BASE_MAX) return ignore('busy scene around the basket');
  if (weakFrames >= cfg.EXIT_WEAK_FRAMES) return ignore('ambiguous motion after contact');
  // A confirmed in-core resting disc outweighs secondary, weaker blobs in the boundary band.
  if (restBand && !stayOk) return ignore('ambiguous resting disc near the cage');

  const fAudio = cm ? clamp01(((cm.riseDb ?? 0) - 8) / 12) : 0;
  const fStay = stayOk ? clamp01(stay.count / cfg.STAY_FULL_FRAMES) : 0;
  ev.factors.audio = fAudio;
  ev.factors.stay = fStay;
  ev.factors.cover = clamp01(fps / 10);
  ev.factors.quiet = clamp01(1 - baseFrac / cfg.EXIT_BASE_MAX);
  ev.factors.arrival = arr.inferred ? 0.75 : 1;
  ev.factors.density = fDensity;
  const fSilent = silent ? cfg.SILENT_CONF : 0;
  ev.factors.silent = fSilent;
  // Do not let a resting-disc detection boost flight confidence: earlier putts may already
  // occupy the basket. A linked stay is supporting evidence only; the current throw's own
  // flight confidence remains the track factor.
  const makeTrackConf = fTrack;
  ev.factors.makeTrack = makeTrackConf;
  const conf = Math.min(makeTrackConf, Math.max(fAudio, fStay, fSilent), ev.factors.cover, ev.factors.quiet, ev.factors.arrival, fDensity);
  ev.factors.final = conf;
  if (conf < cfg.CONF_MIN_MAKE) return ignore('low confidence (make)');
  return {
    state: 'done', result: 'make', missDirection: null, reason: silent ? 'arrived; no chain sound or linked new resting disc' : stayOk && !cm ? 'arrived and linked new disc stayed (no sound)' : 'chain contact and settled', conf, ev,
  };
}

// ===========================================================================================
// 5. JUDGE  (queue of throws waiting for their result)
// ===========================================================================================

/**
 * createOutcomeJudge({ onVerdict })
 *   release(thr)     a throw was detected; thr = { id, t, release, distanceFt, scene, ... }
 *   addFrame(f, now) watcher frame     addChain(ev, now) chain event
 *   step(now)        call a few times a second so timeouts fire
 *   flush(now)       decide every waiting throw now (anything unclear becomes ignored)
 *   onVerdict({ id, thr, result, missDirection, reason, conf, ev, decidedAt })
 */
export function createOutcomeJudge({ onVerdict } = {}) {
  const C = CONFIG.OUTCOME;
  let frames = [];
  let chains = [];
  let pending = [];
  let log = [];
  let replays = [];

  const r4 = (v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);

  // Everything analyzeThrow saw for this throw, so it can be re-run offline with other thresholds.
  function makeReplay(p, v) {
    const t = p.thr.t;
    const { scene, snapshot, ...thr } = p.thr;
    return {
      id: v.id,
      thr,
      scene,
      snapshot: snapshot || null,
      verdict: { result: v.result, dir: v.missDirection, reason: v.reason, conf: v.conf, decidedAt: v.decidedAt },
      chains: chains.filter((e) => e.t >= t - 1000 && e.t <= t + C.HORIZON_MS + 1000),
      chainsAll: chains.map((e) => ({ ...e })), // every chain event heard recently, to tell "no sound" from "sound not matched"
      frames: frames.filter((f) => f.t >= t - 2000 && f.t <= t + C.HORIZON_MS).map((f) => ({
        t: r4(f.t), ms: r4(f.ms), fgOut: r4(f.fgOut), warm: f.warm, dropped: f.dropped, player: f.player,
        blobs: f.blobs.map((b) => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h), area: b.area, move: r4(b.move) })),
      })),
    };
  }

  function finish(p, r, now) {
    const v = {
      id: p.thr.id,
      thr: p.thr,
      result: r.result,
      missDirection: r.missDirection,
      reason: r.reason,
      conf: r.conf,
      ev: r.ev,
      decidedAt: now,
    };
    log.push({
      id: v.id, t: p.thr.t, distanceFt: p.thr.distanceFt, result: v.result, dir: v.missDirection,
      reason: v.reason, conf: v.conf, ev: v.ev, decidedAfterMs: now - p.thr.t,
    });
    if (log.length > C.LOG_N) log.shift();
    replays.push(makeReplay(p, v));
    if (replays.length > C.REPLAY_N) replays.shift();
    if (onVerdict) onVerdict(v);
  }

  function run(now, forceAll) {
    for (let i = 0; i < pending.length;) {
      const p = pending[i];
      const next = pending[i + 1];
      const endT = next ? next.thr.t - 50 : Infinity;
      const final = forceAll || now >= p.thr.t + C.HORIZON_MS || (next && now >= next.thr.t + 300);
      const r = analyzeThrow({
        thr: p.thr, scene: p.thr.scene, frames, chains, now, final: !!final, endT,
      }, C);
      p.last = r;
      if (r.state === 'done') { pending.splice(i, 1); finish(p, r, now); } else i += 1;
    }
  }

  return {
    release(thr, now = thr.t) { pending.push({ thr, last: null }); run(now, false); },
    addFrame(f, now = f.t) {
      frames.push(f);
      const cut = f.t - C.FRAME_BUF_MS;
      while (frames.length && frames[0].t < cut) frames.shift();
      if (pending.length) run(now, false);
    },
    addChain(ev, now = ev.t) {
      chains.push(ev);
      while (chains.length > 30) chains.shift();
      if (pending.length) run(now, false);
    },
    step(now) { if (pending.length) run(now, false); },
    flush(now) { if (pending.length) run(now, true); },
    pendingCount: () => pending.length,
    reset() { frames = []; chains = []; pending = []; log = []; replays = []; },
    getReplays: () => replays,
    getInfo: () => ({
      pending: pending.map((p) => ({ id: p.thr.id, t: p.thr.t, last: p.last })),
      log: log.map((l) => ({ ...l })),
      frames: frames.length,
    }),
  };
}

// ===========================================================================================
// 6. OUTCOME TRACKER  (wires watcher + judge to the app)
// ===========================================================================================

/**
 * createOutcomeTracker({ video, onVerdict })
 *   start() / stop() / reset()
 *   setScene({ active, roundNumber, box, anchor, landmarks })  call every pose frame
 *       active   true while a round is open and the screen is LIVE / FLASH
 *       box      finder.getInfo().locked   anchor  round.getAnchor()   landmarks  pose landmarks|null
 *   release(thr)  a throw was detected (from throws.js onThrow)
 *   chain(ev)     a chain event (from the chain detector)
 *   flush()       decide every waiting throw now
 *   pendingCount(), getInfo()
 */
export function createOutcomeTracker({ video, onVerdict } = {}) {
  const C = CONFIG.OUTCOME;
  const judge = createOutcomeJudge({ onVerdict });
  const idleWatcher = {
    start() {}, stop() {}, setRoi() {}, setPlayer() {}, reset() {},
    getInfo: () => ({
      running: false, mode: 'idle', roi: null, w: 0, h: 0, ms: 0, fps: 0, frames: 0, fgOut: 0,
    }),
  };
  let watcher = idleWatcher;
  const onFrame = (f) => { lastFrame = f; judge.addFrame(f, performance.now()); };
  let scene = null;
  let gate = 'idle';
  let lastRound = null;
  let lastFrame = null;
  let timer = 0;
  let seq = 0;
  let snapCanvas = null;

  // One small JPEG of the whole frame at the release, to check the basket box and the scene.
  function grabSnapshot() {
    try {
      if (!video || !video.videoWidth) return null;
      if (!snapCanvas) snapCanvas = document.createElement('canvas');
      const w = Math.min(C.SNAPSHOT_W, video.videoWidth);
      snapCanvas.width = w;
      snapCanvas.height = Math.round((w * video.videoHeight) / video.videoWidth);
      snapCanvas.getContext('2d').drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
      return snapCanvas.toDataURL('image/jpeg', 0.6);
    } catch (_) { return null; }
  }

  return {
    getReplays: () => judge.getReplays(),
    /** track: the camera's video track, so the frames can be analysed in a worker. */
    start(track = null) {
      watcher.stop();
      watcher = createDiscWatcher({ video, track, onFrame });
      watcher.start();
      clearInterval(timer);
      timer = setInterval(() => judge.step(performance.now()), 100);
    },
    stop() {
      watcher.stop();
      watcher = idleWatcher;
      clearInterval(timer);
      timer = 0;
    },
    reset() {
      judge.reset();
      watcher.reset();
      scene = null;
      gate = 'idle';
      lastRound = null;
      lastFrame = null;
    },
    setScene({ active, roundNumber, box, anchor, landmarks }) {
      const aspect = video && video.videoHeight ? video.videoWidth / video.videoHeight : null;
      if (box && box.manual && !box.refined && box.yn != null && anchor && aspect) {
        // Hand-set basket: assume a standard cage size at the thrower's scale.
        box = { ...box, wn: C.MANUAL_CAGE_FT / anchor.ftPerNormX, hn: (C.MANUAL_CAGE_FT * aspect) / anchor.ftPerNormX };
      }
      scene = box && anchor && aspect
        ? {
          box,
          dir: Math.sign(box.xn - anchor.xn) || 1,
          anchor,
          ftPerNormX: anchor.ftPerNormX,
          aspect,
        }
        : null;
      gate = !active ? 'idle' : checkScene(scene, C) || null;
      if (roundNumber !== lastRound) { lastRound = roundNumber; watcher.reset(); }
      if (active && !gate) {
        watcher.setRoi(corridorRoi(scene, C));
        const padX = C.PLAYER_PAD_FT / scene.ftPerNormX;
        watcher.setPlayer(playerBox(landmarks, padX, padX * aspect));
      } else {
        watcher.setRoi(null);
      }
    },
    release(thr) {
      seq += 1;
      const t = {
        ...thr, id: seq, scene, gate, snapshot: C.SNAPSHOT_W ? grabSnapshot() : null,
      };
      judge.release(t, performance.now());
    },
    chain(ev) { judge.addChain(ev, performance.now()); },
    flush() { judge.flush(performance.now()); },
    pendingCount: () => judge.pendingCount(),
    getInfo: () => ({
      gate,
      scene,
      watcher: watcher.getInfo(),
      judge: judge.getInfo(),
      frame: lastFrame,
    }),
  };
}
