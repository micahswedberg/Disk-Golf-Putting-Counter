// throws.js - detects a putt release from wrist motion. Pure logic (no DOM, no timers).
//
// Call update(frame, now, ctx) once per pose frame. When a release is accepted it calls
// onThrow({ t, distanceFt, arm, peakSpeed, gain, ext, number }). It never tracks the disc and
// never decides make/miss.
//
// Signal (per wrist, in BODY HEIGHTS so the player's distance from the phone does not matter):
//   forward speed  wrist velocity toward the basket (a few frames, see VEL_WINDOW_MS)
//   extension      how far the wrist is ahead of the shoulder, toward the basket
// A swing opens when forward speed passes SPEED_START, tracks its peak, and closes when speed
// falls below SPEED_END (the follow-through). Then it must pass every test:
//   fast enough, long enough, wrist ends forward of the shoulder and travelled forward, mostly
//   level, AND the body gates read at peak speed: upright (not bending), wrist above the hips
//   (not reaching into the bag), hips still, feet on the throwing spot.
// Both wrists are tracked because from the side the model cannot be trusted on handedness.
//
// ctx = { active, roundNumber, basketX, anchor, feetXn, heightPx, distLiveFt }
//   active       true only while the round is open and the screen is LIVE / FLASH
//   anchor       from round.js getAnchor() ({ xn, ftPerNormX, distanceFt })
//   heightPx     player's pixel height from round.js (the scale)

import { CONFIG } from './config.js';

const C = CONFIG.THROW;
const ARMS = [['L', 15], ['R', 16]]; // MediaPipe wrist landmarks
const SHOULDERS = [11, 12];
const HIPS = [23, 24];
const NOSE = 0;

const range = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
const vis = (p, min) => !!p && (p.visibility ?? 0) >= min;

/** Midpoint of the visible landmarks in `ids`, or null. */
function mid(L, ids) {
  const pts = ids.map((i) => L[i]).filter((p) => vis(p, C.BODY_VIS_MIN));
  if (!pts.length) return null;
  return {
    x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
  };
}

/** Forward speed (body heights / s) from the newest sample back about VEL_WINDOW_MS. */
function velocity(buf, t) {
  const cur = buf[buf.length - 1];
  let ref = null;
  for (let i = buf.length - 2; i >= 0; i -= 1) {
    const age = t - buf[i].t;
    if (age >= C.VEL_MIN_SPAN_MS) ref = buf[i];
    if (age >= C.VEL_WINDOW_MS) break;
  }
  if (!ref) return null;
  return { ref, vf: ((cur.X - ref.X) / (cur.t - ref.t)) * 1000 };
}

export function createThrowDetector({ onThrow } = {}) {
  let arms; let hipBuf; let trace; let events; let detected;
  let roundNumber; let lastThrowT; let wasActive; let liveInfo;

  const newArm = () => ({
    buf: [], swing: null, rearm: false, lastT: -Infinity, v: null, ext: null,
  });

  /** Forget in-progress motion (not the throw count or the log). */
  function clearMotion() {
    arms = { L: newArm(), R: newArm() };
    hipBuf = [];
  }

  function reset() {
    clearMotion();
    trace = [];
    events = [];
    detected = 0;
    roundNumber = null;
    lastThrowT = -Infinity;
    wasActive = false;
    liveInfo = {};
  }
  reset();

  function logEvent(e) {
    events.push(e);
    if (events.length > 40) events.shift();
  }

  /** Why a finished swing is not a putt, or null if it is one. */
  function verdict(sw, m) {
    if (m.dur < C.SWING_MIN_MS) return 'short';
    if (sw.peakV < C.SPEED_MIN) return 'slow';
    if (m.gain < C.EXT_GAIN_MIN) return 'gain';
    if (sw.maxExt < C.EXT_MIN) return 'reach';
    if (m.share < C.FWD_SHARE_MIN) return 'dir';
    const g = sw.gate;
    if (g.tilt == null || g.tilt > C.MAX_TILT_DEG) return 'bend';
    if (g.headRatio != null && g.headRatio < C.MIN_HEAD_RATIO) return 'bend';
    if (g.rise == null || g.rise < C.MIN_WRIST_RISE) return 'low';
    if (g.hipMove == null || g.hipMove > C.HIP_MAX_MOVE) return 'hips';
    if (g.offSpotFt == null || g.offSpotFt > C.ANCHOR_MAX_FT) return 'off spot';
    if (g.distFt == null) return 'no dist';
    if (sw.peakT - lastThrowT < C.MIN_GAP_MS) return 'gap';
    return null;
  }

  function finish(name, arm) {
    const sw = arm.swing;
    arm.swing = null;
    arm.rearm = true;

    // Backswing position = lowest extension just before the peak.
    let minS = null;
    for (const q of arm.buf) {
      if (q.t >= sw.peakT - C.BACK_WINDOW_MS && q.t <= sw.peakT && (!minS || q.ext < minS.ext)) {
        minS = q;
      }
    }
    const gain = minS ? sw.maxExt - minS.ext : 0;
    let share = 0;
    if (minS) {
      const dx = sw.peakX - minS.X;
      const dy = sw.peakY - minS.Y;
      const len = Math.hypot(dx, dy);
      share = len > 1e-6 ? dx / len : 0;
    }
    const m = { dur: sw.lastT - sw.t0, gain, share };
    const reason = verdict(sw, m);
    const dist = sw.gate.distFt == null
      ? null
      : Math.round(Math.min(Math.max(sw.gate.distFt, CONFIG.DIST_MIN_FT), CONFIG.DIST_MAX_FT));

    logEvent({
      t: sw.peakT, ok: !reason, reason, arm: name, peakV: sw.peakV, gain, share, dist,
    });
    if (reason) return;

    lastThrowT = sw.peakT;
    detected += 1;
    for (const [other, a] of Object.entries(arms)) { // one throw, one event
      if (other !== name) { a.swing = null; a.rearm = true; }
    }
    if (onThrow) {
      onThrow({
        t: sw.peakT, distanceFt: dist, arm: name, peakSpeed: sw.peakV, gain, ext: sw.maxExt, number: detected,
      });
    }
  }

  function abort(name, arm) {
    const sw = arm.swing;
    arm.swing = null;
    arm.rearm = true;
    if (sw && sw.peakV >= C.SPEED_MIN) {
      logEvent({
        t: sw.peakT, ok: false, reason: 'lost', arm: name, peakV: sw.peakV, gain: 0, share: 0, dist: null,
      });
    }
  }

  function stepArm(name, idx, body, now) {
    const arm = arms[name];
    const p = body.L[idx];
    let s = null;
    if (body.ok && vis(p, C.VIS_MIN) && p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1) {
      s = {
        t: now,
        X: (body.dir * p.x * body.w) / body.px,
        Y: (p.y * body.h) / body.px,
        ext: (body.dir * (p.x - body.sh.x) * body.w) / body.px,
        rise: body.torsoPx > 0 ? ((body.hip.y - p.y) * body.h) / body.torsoPx : null,
      };
    }
    if (!s) {
      arm.v = null;
      arm.ext = null;
      if (arm.swing && now - arm.lastT > C.GAP_MS) abort(name, arm);
      return;
    }

    arm.buf.push(s);
    while (arm.buf.length > 1 && now - arm.buf[0].t > C.BUF_MS) arm.buf.shift();
    arm.lastT = now;
    arm.ext = s.ext;
    const vel = velocity(arm.buf, now);
    arm.v = vel ? vel.vf : null;
    if (!vel) return;
    const vf = vel.vf;

    if (!arm.swing) {
      if (arm.rearm) {
        if (vf < C.SPEED_END) arm.rearm = false;
        return;
      }
      if (vf >= C.SPEED_START) {
        arm.swing = {
          t0: vel.ref.t, lastT: now, peakV: vf, peakT: now, maxExt: s.ext,
          peakX: s.X, peakY: s.Y, gate: { ...body.gate, rise: s.rise },
        };
      }
      return;
    }

    const sw = arm.swing;
    sw.lastT = now;
    sw.maxExt = Math.max(sw.maxExt, s.ext);
    if (vf > sw.peakV) {
      sw.peakV = vf;
      sw.peakT = now;
      sw.peakX = s.X;
      sw.peakY = s.Y;
      sw.gate = { ...body.gate, rise: s.rise };
    }
    if (vf < C.SPEED_END || now - sw.t0 > C.SWING_MAX_MS) finish(name, arm);
  }

  /** Feed one pose frame. Returns nothing; throws arrive through onThrow. */
  function update(frame, now, ctx) {
    const usable = ctx && ctx.active && ctx.anchor && ctx.basketX != null && ctx.heightPx;
    if (!usable) {
      if (wasActive) clearMotion();
      wasActive = false;
      liveInfo = {};
      return;
    }
    wasActive = true;
    if (ctx.roundNumber !== roundNumber) {
      roundNumber = ctx.roundNumber;
      detected = 0;
      clearMotion();
    }
    while (trace.length && now - trace[0].t > C.TRACE_MS) trace.shift();

    const L = frame && frame.landmarks;
    if (!L || L.length < 33) {
      for (const [name, arm] of Object.entries(arms)) {
        arm.v = null;
        arm.ext = null;
        if (arm.swing && now - arm.lastT > C.GAP_MS) abort(name, arm);
      }
      trace.push({ t: now, v: { L: null, R: null }, e: { L: null, R: null } });
      return;
    }

    const { w, h } = frame;
    const px = ctx.heightPx;
    const dir = Math.sign(ctx.basketX - ctx.anchor.xn) || 1; // +1: basket is to the right
    const sh = mid(L, SHOULDERS);
    const hip = mid(L, HIPS);
    const ok = !!(sh && hip);
    const torsoPx = ok ? (hip.y - sh.y) * h : null;

    let tilt = null;
    let headRatio = null;
    if (ok) {
      if (torsoPx > 0) {
        tilt = (Math.atan2(Math.abs(sh.x - hip.x) * w, torsoPx) * 180) / Math.PI;
        if (vis(L[NOSE], C.BODY_VIS_MIN)) headRatio = ((sh.y - L[NOSE].y) * h) / torsoPx;
      } else {
        tilt = 90; // shoulders at or below the hips: bent right over
      }
    }
    if (hip) {
      hipBuf.push({ t: now, X: (dir * hip.x * w) / px, Y: (hip.y * h) / px });
    }
    while (hipBuf.length && now - hipBuf[0].t > C.HIP_WINDOW_MS) hipBuf.shift();
    const hipMove = hipBuf.length >= 2
      ? Math.max(range(hipBuf.map((q) => q.X)), range(hipBuf.map((q) => q.Y)))
      : null;
    const offSpotFt = ctx.feetXn != null
      ? Math.abs(ctx.feetXn - ctx.anchor.xn) * ctx.anchor.ftPerNormX
      : null;
    const distFt = ctx.distLiveFt ?? ctx.anchor.distanceFt ?? null;

    const body = {
      L, w, h, px, dir, sh, hip, ok, torsoPx,
      gate: { tilt, headRatio, hipMove, offSpotFt, distFt },
    };
    for (const [name, idx] of ARMS) stepArm(name, idx, body, now);

    trace.push({
      t: now,
      v: { L: arms.L.v, R: arms.R.v },
      e: { L: arms.L.ext, R: arms.R.ext },
    });
    liveInfo = {
      vL: arms.L.v, vR: arms.R.v, eL: arms.L.ext, eR: arms.R.ext,
      tilt, headRatio, hipMove, offSpotFt,
    };
  }

  return {
    update,
    reset,
    /** { detected, live, recent[] } for the debug read-out. */
    getInfo: () => ({ detected, live: liveInfo, recent: events.slice(-C.LOG_N) }),
    /** { samples[{ t, v:{L,R}, e:{L,R} }], events[] } for the debug motion trace. */
    getTrace: () => ({ samples: trace, events }),
  };
}
