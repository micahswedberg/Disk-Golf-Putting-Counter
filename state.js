// state.js - the state machine. Pure logic, no DOM, no timers.
//
// Usage: state = reduce(state, event). Unhandled or ignored events return the
// SAME state object, so callers can skip re-rendering when nothing changed.
//
// Events:
//   { type: 'start', sessionId, camera, audio }
//   { type: 'stop' }
//   { type: 'flags', patch }   patch of { camera, audio, basket, player, stable }
//   { type: 'throw', result: 'make'|'miss'|'ignored', distanceFt, speedMph, releaseAngleDeg, missDirection, now }
//   { type: 'flashDone', flashId }
//   { type: 'roundEnd' }

import { CONFIG } from './config.js';

export const SCREEN = Object.freeze({
  SETUP: 'SETUP',
  NOT_READY: 'NOT_READY',
  LIVE: 'LIVE',
  FLASH_MADE: 'FLASH_MADE',
  FLASH_MISS: 'FLASH_MISS',
  POST_ROUND: 'POST_ROUND',
});

export const REASON = Object.freeze({
  NO_CAMERA: 'NO CAMERA',
  NO_AUDIO: 'NO AUDIO',
  FINDING_BASKET: 'FINDING BASKET',
  STEP_INTO_FRAME: 'STEP INTO FRAME',
  STAND_STILL: 'STAND STILL',
  TRACKING_LOST: 'TRACKING LOST',
});

export const isFlash = (screen) => screen === SCREEN.FLASH_MADE || screen === SCREEN.FLASH_MISS;

// ---- Helpers shared with display / stats ----------------------------------

/** Bucket index 0..BUCKET_COUNT-1 for a distance in feet. */
export function bucketIndex(ft) {
  const i = Math.floor((ft - CONFIG.BUCKET_MIN_FT) / CONFIG.BUCKET_SIZE_FT);
  return Math.min(Math.max(i, 0), CONFIG.BUCKET_COUNT - 1);
}

/** Whole-number make percent, or null when nothing was thrown. */
export function makePct(made, thrown) {
  return thrown > 0 ? Math.round((100 * made) / thrown) : null;
}

/** Session make % per distance bucket: [{ index, lo, hi, made, thrown, pct }]. */
export function bucketStats(throws) {
  const out = Array.from({ length: CONFIG.BUCKET_COUNT }, (_, i) => ({
    index: i,
    lo: CONFIG.BUCKET_MIN_FT + i * CONFIG.BUCKET_SIZE_FT,
    hi: CONFIG.BUCKET_MIN_FT + (i + 1) * CONFIG.BUCKET_SIZE_FT,
    made: 0,
    thrown: 0,
    pct: null,
  }));
  for (const t of throws) {
    const b = out[t.distanceBucket];
    b.thrown += 1;
    if (t.result === 'make') b.made += 1;
  }
  for (const b of out) b.pct = makePct(b.made, b.thrown);
  return out;
}

// ---- State ----------------------------------------------------------------

const emptyRound = () => ({ counted: 0, made: 0, ignored: 0, distances: [] });

export function createState() {
  return {
    screen: SCREEN.SETUP,
    reason: null, // REASON value while NOT_READY
    // Readiness inputs. camera/audio come from the devices; the rest from tracking.
    flags: { camera: false, audio: false, basket: false, player: false, stable: false },
    lost: false, // tracking dropped mid-round (shows TRACKING LOST, resumes same round)
    sessionId: null,
    roundOpen: false,
    roundNumber: 0,
    round: emptyRound(), // counted = thrown (non-ignored), made, ignored
    lastRound: null, // round summary shown on POST_ROUND
    rounds: [], // all closed round summaries
    throws: [], // all counted throw records
    flash: null, // detail for the current flash
    flashId: 0, // bumps on every flash so stale timers can be ignored
  };
}

function reasonFor(s) {
  const f = s.flags;
  if (!f.camera) return REASON.NO_CAMERA;
  if (!f.audio) return REASON.NO_AUDIO;
  if (s.lost) return REASON.TRACKING_LOST;
  if (!f.basket) return REASON.FINDING_BASKET;
  if (!f.player) return REASON.STEP_INTO_FRAME;
  return REASON.STAND_STILL;
}

function enterLive(s) {
  if (!s.roundOpen) {
    s.roundNumber += 1;
    s.round = emptyRound();
    s.roundOpen = true;
  }
  s.lost = false;
  s.reason = null;
  s.screen = SCREEN.LIVE;
}

function enterNotReady(s) {
  s.screen = SCREEN.NOT_READY;
  s.flash = null;
  s.reason = reasonFor(s);
}

/** Leave LIVE/FLASH because readiness was lost. */
function dropToNotReady(s) {
  const started = s.round.counted + s.round.ignored > 0;
  if (started) {
    s.lost = true;
  } else {
    // Round never really began: hand the number back.
    s.roundOpen = false;
    s.roundNumber -= 1;
  }
  enterNotReady(s);
}

/** Close the open round into a summary. Returns nothing if it had no throws. */
function closeRound(s) {
  if (!s.roundOpen) return;
  s.roundOpen = false;
  const r = s.round;
  if (r.counted + r.ignored === 0) return;
  const mean = r.distances.length
    ? r.distances.reduce((a, b) => a + b, 0) / r.distances.length
    : null;
  s.lastRound = {
    roundNumber: s.roundNumber,
    distanceFt: mean === null ? null : Math.round(mean),
    thrown: r.counted,
    made: r.made,
    ignored: r.ignored,
  };
  s.rounds.push(s.lastRound);
}

/** Re-evaluate the screen after flags change. */
function settle(s) {
  const f = s.flags;
  const present = f.camera && f.audio && f.basket && f.player;
  const ready = present && f.stable;
  switch (s.screen) {
    case SCREEN.NOT_READY: {
      // Mid-round recovery resumes without needing the player to stand still
      // (they were bending to the bag when tracking dropped).
      const resume = s.roundOpen && s.lost ? present : ready;
      if (resume) enterLive(s);
      else s.reason = reasonFor(s);
      break;
    }
    case SCREEN.LIVE:
    case SCREEN.FLASH_MADE:
    case SCREEN.FLASH_MISS:
      // Bending or shifting feet (stable=false) must NOT end anything.
      if (!present) dropToNotReady(s);
      break;
    case SCREEN.POST_ROUND:
      // Stay blue while the player walks around the basket.
      if (!f.camera || !f.audio) enterNotReady(s);
      else if (f.player) {
        if (ready) enterLive(s);
        else enterNotReady(s);
      }
      break;
    default:
      break;
  }
  return s;
}

export function reduce(state, ev) {
  switch (ev.type) {
    case 'start': {
      const s = createState();
      s.sessionId = ev.sessionId;
      s.flags.camera = !!ev.camera;
      s.flags.audio = !!ev.audio;
      s.screen = SCREEN.NOT_READY;
      s.reason = reasonFor(s);
      return s;
    }

    case 'stop': {
      if (state.screen === SCREEN.SETUP) return state;
      const s = structuredClone(state);
      closeRound(s);
      s.screen = SCREEN.SETUP;
      s.reason = null;
      s.flash = null;
      s.lost = false;
      return s;
    }

    case 'flags': {
      if (state.screen === SCREEN.SETUP) return state;
      const s = structuredClone(state);
      Object.assign(s.flags, ev.patch);
      return settle(s);
    }

    case 'throw': {
      // A throw made while NOT_READY (or in SETUP / POST_ROUND) is not recorded.
      if (state.screen !== SCREEN.LIVE && !isFlash(state.screen)) return state;
      const s = structuredClone(state);
      if (ev.result === 'ignored') {
        s.round.ignored += 1; // no flash, no record
        return s;
      }
      const made = ev.result === 'make';
      s.round.counted += 1;
      if (made) s.round.made += 1;
      s.round.distances.push(ev.distanceFt);
      const detail = {
        distanceFt: ev.distanceFt,
        speedMph: ev.speedMph ?? null,
        releaseAngleDeg: ev.releaseAngleDeg ?? null,
        missDirection: made ? null : ev.missDirection ?? null,
      };
      s.throws.push({
        sessionId: s.sessionId,
        timestamp: new Date(ev.now).toISOString(),
        roundNumber: s.roundNumber,
        throwNumber: s.round.counted,
        distanceFt: detail.distanceFt,
        distanceBucket: bucketIndex(detail.distanceFt),
        result: made ? 'make' : 'miss',
        missDirection: detail.missDirection,
        speedMph: detail.speedMph,
        releaseAngleDeg: detail.releaseAngleDeg,
      });
      s.flash = detail;
      s.flashId += 1;
      s.screen = made ? SCREEN.FLASH_MADE : SCREEN.FLASH_MISS;
      return s;
    }

    case 'flashDone': {
      if (!isFlash(state.screen) || ev.flashId !== state.flashId) return state;
      const s = structuredClone(state);
      s.screen = SCREEN.LIVE;
      s.flash = null;
      return s;
    }

    case 'roundEnd': {
      if (state.screen !== SCREEN.LIVE && !isFlash(state.screen)) return state;
      if (state.round.counted + state.round.ignored === 0) return state;
      const s = structuredClone(state);
      closeRound(s);
      s.flash = null;
      s.screen = SCREEN.POST_ROUND;
      return s;
    }

    default:
      return state;
  }
}
