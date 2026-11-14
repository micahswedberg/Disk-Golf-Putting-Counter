// round.js - turns pose landmarks into player state and round events.
// Pure logic (no DOM, no timers): call update() once per pose frame.
//
// Produces:
//   flags.player  one person in view (strict: fully in frame; relaxed while a round is open,
//                 so bending to the bag never drops it), with a grace period for flicker
//   flags.stable  upright + still for READY_HOLD_MS (RETURN_HOLD_MS and far enough from the
//                 basket after a round)
//   roundEnd      feet moved toward the basket beyond ROUND_END_TOWARD_FT of the anchor spot
//   view          what is wrong with the picture, for the camera read-out:
//                 'ok' | 'none' | 'head' | 'feet' | 'side' | 'weak'
// It also learns the anchor spot and the feet-per-pixel scale while the player stands still.
// Coordinates: x, y are normalized to the RAW (unmirrored) camera frame.

import { CONFIG } from './config.js';
import { SCREEN } from './state.js';

const T = CONFIG.TRACK;

// MediaPipe pose landmark indices.
const KEY = [0, 11, 12, 23, 24, 27, 28, 29, 30, 31, 32]; // nose, shoulders, hips, ankles, heels, foot index
const PAIRS = [[11, 12], [23, 24], [27, 28], [29, 30]]; // at least one of each pair must be seen
const FEET = [27, 28, 29, 30, 31, 32];
const FLOOR = [29, 30, 31, 32]; // heel / foot-index landmarks used to find the floor

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const range = (a) => Math.max(...a) - Math.min(...a);

/** Per-frame measurements from one set of landmarks. No history. */
function analyze(frame) {
  const out = {
    detected: false, view: 'none', strict: false, relaxed: false, upright: false,
    feetXn: null, hipXn: null, hipYn: null, heightPx: null,
    tilt: null, torsoRatio: null, headRatio: null,
  };
  const L = frame && frame.landmarks;
  if (!L || L.length < 33) return out;
  const { w, h } = frame;
  const m = T.EDGE_MARGIN;
  const vis = (i) => L[i].visibility ?? 0;
  const inFrame = (p) => p.x > m && p.x < 1 - m && p.y > m && p.y < 1 - m;
  const ok = (i) => vis(i) >= T.VIS_MIN && inFrame(L[i]);

  if (mean(KEY.map(vis)) < T.MIN_MEAN_VIS) return out;
  out.detected = true;

  let top = false; let bottom = false; let side = false;
  for (const i of KEY) {
    const p = L[i];
    if (p.y < m) top = true;
    if (p.y > 1 - m) bottom = true;
    if (p.x < m || p.x > 1 - m) side = true;
  }

  const feetOk = FEET.filter(ok);
  const mid = (a, b) => {
    const pts = [a, b].filter(ok).map((i) => L[i]);
    return pts.length ? { x: mean(pts.map((p) => p.x)), y: mean(pts.map((p) => p.y)) } : null;
  };
  const sh = mid(11, 12);
  const hip = mid(23, 24);
  const ank = mid(27, 28);

  out.strict = PAIRS.every(([a, b]) => ok(a) || ok(b)) && ok(0) && !top && !bottom && !side;
  out.relaxed = feetOk.length >= 2 && !!hip;
  if (bottom) out.view = 'feet';
  else if (top) out.view = 'head';
  else if (side) out.view = 'side';
  else out.view = out.strict ? 'ok' : 'weak';

  if (feetOk.length) out.feetXn = mean(feetOk.map((i) => L[i].x));
  if (hip) { out.hipXn = hip.x; out.hipYn = hip.y; }

  if (sh && hip && ank) {
    const torsoH = (hip.y - sh.y) * h;
    const legH = (ank.y - hip.y) * h;
    if (torsoH > 0 && legH > 0) {
      out.tilt = (Math.atan2(Math.abs(sh.x - hip.x) * w, torsoH) * 180) / Math.PI;
      out.torsoRatio = torsoH / legH;
      out.headRatio = ((sh.y - L[0].y) * h) / torsoH;
      out.upright = out.strict
        && out.tilt <= T.UPRIGHT_MAX_TILT_DEG
        && out.torsoRatio >= T.UPRIGHT_TORSO_RATIO[0]
        && out.torsoRatio <= T.UPRIGHT_TORSO_RATIO[1]
        && out.headRatio >= T.UPRIGHT_MIN_HEAD_RATIO;
    }
  }

  if (out.strict) {
    const floors = FLOOR.filter(ok).map((i) => L[i].y * h);
    if (floors.length) {
      const px = (Math.max(...floors) - L[0].y * h) / T.NOSE_HEIGHT_FRAC;
      if (px > 0) out.heightPx = px;
    }
  }
  return out;
}

/**
 * createRoundTracker({ heightIn })
 * update(frame, now, state) -> { flags: { player, stable }, roundEnd, view }
 *   frame = { w, h, landmarks|null } from pose.js; state = the state machine state
 *   (screen and roundOpen are read, never written).
 */
export function createRoundTracker({ heightIn = CONFIG.HEIGHT_DEFAULT_IN } = {}) {
  let heightFt = heightIn / 12;
  let basketX = CONFIG.BASKET_X_NORM;

  let samples; let learn; let playerFlag; let presentFrames; let lastSeen;
  let stillSince; let anchor; let ftPerNormX; let lastHeightPx;
  let endFired; let towardSince; let viewRaw; let viewSince; let viewShown;
  let snap;

  function reset() {
    samples = []; // relaxed frames: { t, fx, hx, hy }
    learn = []; // strict still frames since stillSince: { fx, hp }
    playerFlag = false;
    presentFrames = 0;
    lastSeen = -Infinity;
    stillSince = null;
    anchor = null; // { xn } throwing spot, learned while still
    ftPerNormX = null; // feet per unit of normalized x (frame width), from height / pixel height
    lastHeightPx = null;
    endFired = false;
    towardSince = null;
    viewRaw = 'none';
    viewSince = 0;
    viewShown = 'none';
    snap = {};
  }
  reset();

  function update(frame, now, ctx) {
    const a = analyze(frame);
    const w = frame ? frame.w : 1;
    const h = frame ? frame.h : 1;
    const screen = ctx.screen;
    const inRound = !!ctx.roundOpen;
    const live = screen === SCREEN.LIVE || screen === SCREEN.FLASH_MADE || screen === SCREEN.FLASH_MISS;
    const post = screen === SCREEN.POST_ROUND;

    // ---- Presence with grace ------------------------------------------------
    if (inRound ? a.relaxed : a.strict) {
      presentFrames += 1;
      lastSeen = now;
      if (!playerFlag && presentFrames >= T.PRESENT_FRAMES) playerFlag = true;
    } else {
      presentFrames = 0;
      if (playerFlag && now - lastSeen > T.LOST_MS) playerFlag = false;
    }

    // ---- Samples and stillness ----------------------------------------------
    if (a.relaxed && a.feetXn != null) {
      samples.push({ t: now, fx: a.feetXn, hx: a.hipXn, hy: a.hipYn });
      while (samples.length > 1 && now - samples[0].t > 3000) samples.shift();
    }
    if (a.heightPx) lastHeightPx = a.heightPx;

    let spread = null;
    let still = false;
    const win = samples.filter((s) => now - s.t <= T.STILL_WINDOW_MS);
    if (
      win.length >= T.STILL_MIN_SAMPLES
      && now - win[0].t >= 0.7 * T.STILL_WINDOW_MS
      && lastHeightPx
    ) {
      spread = Math.max(
        range(win.map((s) => s.fx)) * w,
        range(win.map((s) => s.hx)) * w,
        range(win.map((s) => s.hy)) * h,
      ) / lastHeightPx;
      still = spread <= T.STILL_MAX_MOVE_FRAC;
    }

    const raw = a.strict && a.upright && still;
    if (raw) {
      if (stillSince == null) stillSince = now;
      if (a.heightPx) learn.push({ fx: a.feetXn, hp: a.heightPx });
      if (learn.length > 90) learn.shift();
    } else {
      stillSince = null;
      learn = [];
    }
    const heldMs = stillSince == null ? 0 : now - stillSince;

    // Candidate anchor and scale from the still window.
    const candFx = learn.length >= 3 ? median(learn.map((s) => s.fx)) : null;
    const candHp = learn.length >= 3 ? median(learn.map((s) => s.hp)) : null;
    const candScale = candHp ? (heightFt / candHp) * w : null;
    const awayFt = basketX != null && candFx != null && candScale
      ? Math.abs(candFx - basketX) * candScale
      : null;

    const need = post ? T.RETURN_HOLD_MS : T.READY_HOLD_MS;
    const stable = raw && heldMs >= need && (!post || awayFt == null || awayFt >= T.RETURN_MIN_FT);

    // Learn the throwing spot until the round is live, then freeze it.
    if (stable && !live && candFx != null && candScale) {
      anchor = { xn: candFx };
      ftPerNormX = candScale;
    }

    // ---- Round end: feet move toward the basket ------------------------------
    let roundEnd = false;
    let towardFt = null;
    const tail = samples.slice(-T.ROUND_END_MEDIAN_N);
    const fxMed = tail.length ? median(tail.map((s) => s.fx)) : null;
    if (live) {
      if (anchor && basketX != null && ftPerNormX && fxMed != null && a.relaxed) {
        towardFt = (fxMed - anchor.xn) * Math.sign(basketX - anchor.xn) * ftPerNormX;
        if (towardFt >= T.ROUND_END_TOWARD_FT) {
          if (towardSince == null) towardSince = now;
          if (!endFired && now - towardSince >= T.ROUND_END_HOLD_MS) {
            roundEnd = true;
            endFired = true;
          }
        } else {
          towardSince = null;
        }
      }
    } else {
      endFired = false;
      towardSince = null;
    }

    // ---- Camera read-out message, debounced ---------------------------------
    const viewNow = inRound && a.relaxed ? 'ok' : a.view;
    if (viewNow !== viewRaw) { viewRaw = viewNow; viewSince = now; }
    if (viewRaw !== viewShown && now - viewSince >= T.VIEW_HOLD_MS) viewShown = viewRaw;

    // ---- Live distance estimate (debug and later phases) ---------------------
    const scale = ftPerNormX || candScale;
    const distLiveFt = basketX != null && fxMed != null && scale
      ? Math.abs(fxMed - basketX) * scale
      : null;

    snap = {
      detected: a.detected, view: viewShown, viewNow: a.view,
      strict: a.strict, relaxed: a.relaxed, upright: a.upright, still, spread,
      tilt: a.tilt, torsoRatio: a.torsoRatio, headRatio: a.headRatio, heldMs,
      feetXn: fxMed, heightPx: lastHeightPx, ftPerNormX,
      anchorXn: anchor ? anchor.xn : null,
      anchorDistFt: anchor && basketX != null && ftPerNormX
        ? Math.abs(anchor.xn - basketX) * ftPerNormX : null,
      distLiveFt, towardFt, awayFt, basketXn: basketX,
      player: playerFlag, stable,
    };

    return { flags: { player: playerFlag, stable }, roundEnd, view: viewShown };
  }

  return {
    update,
    reset,
    snapshot: () => snap,
    setHeightIn(v) { heightFt = v / 12; },
    setBasketX(x) { basketX = x == null ? null : Math.min(Math.max(x, 0), 1); },
    getBasketX: () => basketX,
    /** Throwing spot learned while still: { xn, distanceFt, ftPerNormX } or null. For later phases. */
    getAnchor: () => (anchor && ftPerNormX
      ? {
        xn: anchor.xn,
        ftPerNormX,
        distanceFt: basketX != null ? Math.abs(anchor.xn - basketX) * ftPerNormX : null,
      }
      : null),
    /** Distance of the current feet position from the basket in feet, or null. */
    getDistanceFt: () => (snap.distLiveFt == null ? null : snap.distLiveFt),
  };
}
