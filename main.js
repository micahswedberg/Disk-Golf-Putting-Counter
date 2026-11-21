// main.js - wires setup, state machine, display, camera, pose tracking, basket finder, chain-sound
// detector, disc tracking / make-miss (outcome.js) and (debug only) the simulator.

import { CONFIG } from './config.js';
import { SCREEN, createState, reduce, isFlash } from './state.js';
import { createDisplay } from './display.js';
import { createBasketMark } from './mark.js';
import { renderSetup } from './setup.js';
import * as cam from './camera.js';
import { createPose } from './pose.js';
import { createRoundTracker } from './round.js';
import { createThrowDetector } from './throws.js';
import {
  createBasketFinder, createChainDetector, createOutcomeTracker, playerSpan,
} from './outcome.js';

const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

const setupRoot = document.getElementById('setup');
const screenRoot = document.getElementById('screen');
const debugRoot = document.getElementById('debug');

let state = createState();
let flashTimer = 0;
let seenFlashId = 0;
let debugPanel = null;

// Phase 3: real tracking. The tracker turns pose frames into flags and round events.
const tracker = createRoundTracker({ heightIn: CONFIG.HEIGHT_DEFAULT_IN });
let poseStatus = 'idle';
let lastFrame = null;
let lastFlags = {};
let lastDebugAt = 0;
let bigFeed = false;
let lastMotionAt = 0;

// Phase 4/5b: throw detection. By default (AUTO) the result comes from the disc tracker and the
// chain sound (outcome.js): a verdict arrives about 1-2.5 s after the release, and anything it is
// not sure about is IGNORED. In ?debug=1 the "Outcome" button can force MISS / MAKE / ALT instead,
// which scores every detected release at once like Phase 4 did (for testing the screens).
const OUTCOMES = ['auto', 'miss', 'make', 'alternate'];
let outcomeIdx = 0;
let altFlip = false;

function pickOutcome() {
  const mode = OUTCOMES[outcomeIdx];
  if (mode !== 'alternate') return mode;
  altFlip = !altFlip;
  return altFlip ? 'make' : 'miss';
}

const throwTools = {
  cycleOutcome() {
    outcomeIdx = (outcomeIdx + 1) % OUTCOMES.length;
    if (debugPanel) debugPanel.update();
  },
  getOutcome: () => OUTCOMES[outcomeIdx].toUpperCase(),
};

const detector = createThrowDetector({
  onThrow(t) {
    // Give the independent disc worker an uncontended 1.5 s window to follow the flight.
    // The last player box remains frozen in the worker while pose inference is paused.
    pose.pauseFor(1500, () => detector.clearMotion());
    if (OUTCOMES[outcomeIdx] !== 'auto') { // debug override: score right away
      dispatch({
        type: 'throw',
        result: pickOutcome(),
        distanceFt: t.distanceFt,
        speedMph: null,
        releaseAngleDeg: null,
        missDirection: null,
        now: Date.now(),
      });
      return;
    }
    outcome.release({
      t: t.t,
      release: t.release || null,
      distanceFt: t.distanceFt,
      roundNumber: state.roundNumber,
      date: Date.now(),
    });
  },
});

// Verdicts arrive late (flight + about 1 s of settling), so a round end can be requested while a
// throw is still being judged. The round end waits for it (state.js ignores throws once the round
// is closed), then waits a moment more so a make / miss flash can be seen.
let roundEndHeld = false;
let roundEndTimer = 0;
let holdGuard = 0;

function clearRoundEndHold() {
  roundEndHeld = false;
  clearTimeout(roundEndTimer);
  clearTimeout(holdGuard);
}

function fireRoundEnd(delayMs) {
  clearTimeout(roundEndTimer);
  roundEndTimer = setTimeout(() => { clearRoundEndHold(); dispatch({ type: 'roundEnd' }); }, delayMs);
}

function requestRoundEnd() {
  if (!outcome.pendingCount()) { dispatch({ type: 'roundEnd' }); return; }
  if (roundEndHeld) return;
  roundEndHeld = true;
  // Never wait forever: undecided throws become "ignored".
  holdGuard = setTimeout(() => { outcome.flush(); }, CONFIG.OUTCOME.ROUND_END_HOLD_MAX_MS);
}

function onVerdict(v) {
  if (DEBUG) console.info('verdict', v.result, v.missDirection, v.reason, v.conf.toFixed(2), v.ev);
  dispatch({
    type: 'throw',
    result: v.result, // 'make' | 'miss' | 'ignored'
    distanceFt: v.thr.distanceFt,
    speedMph: null, // Phase 6: from flight.js
    releaseAngleDeg: null,
    missDirection: v.result === 'miss' ? v.missDirection : null,
    now: v.thr.date,
  });
  if (roundEndHeld && !outcome.pendingCount()) {
    clearTimeout(holdGuard);
    fireRoundEnd(v.result === 'ignored' ? 0 : CONFIG.OUTCOME.POST_FLASH_HOLD_MS);
  }
}

// The basket is marked by the user at startup (mark.js): a tap, refined to the cage box (top band to
// tray) by the finder (outcome.js). When the box is confirmed, its x goes to the round tracker and
// the TAP THE BASKET screen clears. A fixed CONFIG.BASKET_X_NORM, or BASKET.AUTO_FIND, still work.
const finder = createBasketFinder({
  onFound(xn) {
    tracker.setBasketX(xn);
    pushBasketFlag();
  },
});

// Chain-rattle events. outcome.js pairs these with the disc reaching the basket to call a make.
// The audio flag now means "mic open, AudioContext running and not silent".
const chains = createChainDetector({
  onChain(ev) {
    if (DEBUG) console.info('chain', ev);
    outcome.chain(ev); // only counts when it matches a disc that reached the basket
  },
  onStatus(ok) {
    dispatch({ type: 'flags', patch: { audio: ok } });
  },
});

/** Send an event through the state machine, then render and schedule flash expiry. */
function dispatch(ev) {
  const next = reduce(state, ev);
  if (next === state) return;
  state = next;

  const inSetup = state.screen === SCREEN.SETUP;
  setupRoot.hidden = !inSetup;
  debugRoot.classList.toggle('on-setup', inSetup);
  screenRoot.hidden = inSetup;
  if (!inSetup) display.render(state);

  if (isFlash(state.screen)) {
    if (state.flashId !== seenFlashId) {
      seenFlashId = state.flashId;
      clearTimeout(flashTimer);
      const id = state.flashId;
      flashTimer = setTimeout(() => dispatch({ type: 'flashDone', flashId: id }), CONFIG.FLASH_MS);
    }
  } else {
    clearTimeout(flashTimer);
  }
  if (debugPanel) debugPanel.update();
}

// ---- Tracking -> state machine ----------------------------------------------

/** Send flag changes (only changes) to the state machine. */
function syncFlags(want) {
  const patch = {};
  for (const k of Object.keys(want)) {
    if (want[k] !== lastFlags[k]) patch[k] = want[k];
  }
  if (!Object.keys(patch).length) return;
  lastFlags = { ...lastFlags, ...patch };
  dispatch({ type: 'flags', patch });
}

/** The locked cage box for the small feed; a plain tap has no size yet, so a typical one is drawn. */
function basketBoxForFeed() {
  const b = finder.getInfo().locked;
  if (!b || b.yn == null) return null;
  if (b.wn != null && b.hn != null) return b;
  const hn = CONFIG.BASKET.TAP_BOX_H;
  const aspect = lastFrame ? lastFrame.w / lastFrame.h : 16 / 9;
  return { ...b, hn, wn: (hn * CONFIG.BASKET.TAP_BOX_ASPECT) / aspect, refined: false, how: 'tap' };
}

function pushBasketFlag() {
  syncFlags({ basket: tracker.getBasketX() != null });
  pushFeed();
}

/** Refresh the corner feed (basket marker, read-out of what is missing, debug landmarks). */
function pushFeed() {
  const snap = tracker.snapshot();
  display.setLiveDistance(snap.anchorDistFt ?? snap.distLiveFt ?? null);
  display.setNear(state.screen === SCREEN.POST_ROUND && snap.view === 'feet');
  display.updateFeed({
    aspect: lastFrame ? lastFrame.w / lastFrame.h : null,
    landmarks: lastFrame ? lastFrame.landmarks : null,
    basketX: tracker.getBasketX(),
    basketBox: basketBoxForFeed(),
    anchorX: snap.anchorXn ?? null,
    feetX: snap.feetXn ?? null,
    view: snap.view ?? 'none',
    poseStatus,
    debug: DEBUG,
  });
}

function onPoseFrame(frame) {
  if (state.screen === SCREEN.SETUP) return;
  lastFrame = frame;
  finder.setExclude(playerSpan(frame.landmarks)); // the player is never the basket
  const now = performance.now();
  const out = tracker.update(frame, now, state);
  syncFlags({ player: out.flags.player, stable: out.flags.stable });
  if (out.roundEnd) requestRoundEnd();

  // Throw detection runs only while a round is open and LIVE / FLASH, so a swing made while
  // NOT_READY or on the blue screen is never counted.
  const snap = tracker.snapshot();
  const active = state.roundOpen && (state.screen === SCREEN.LIVE || isFlash(state.screen));
  outcome.setScene({
    active,
    roundNumber: state.roundNumber,
    box: finder.getInfo().locked,
    anchor: tracker.getAnchor(),
    landmarks: frame.landmarks,
  });
  detector.update(frame, now, {
    active,
    roundNumber: state.roundNumber,
    basketX: tracker.getBasketX(),
    anchor: tracker.getAnchor(),
    feetXn: snap.feetXn,
    heightPx: snap.heightPx,
    distLiveFt: snap.distLiveFt,
  });

  pushFeed();
  if (debugPanel && now - lastMotionAt > 100) {
    lastMotionAt = now;
    debugPanel.drawMotion();
  }
  if (debugPanel && now - lastDebugAt > 200) {
    lastDebugAt = now;
    debugPanel.update();
  }
}

// ---- Debug: basket placement (tap the enlarged feed) ----------------------------

function applyFeedMode() {
  display.setFeedLarge(bigFeed, false);
}

/** Forget the basket and run the "tap the basket" step again. */
function remarkBasket() {
  tracker.setBasketX(null);
  finder.clear();
  mark.begin();
  pushBasketFlag(); // basket flag off -> the TAP THE BASKET screen
}

const basketTools = {
  toggleTap() { remarkBasket(); }, // debug button: mark the basket again
  toggleBig() {
    bigFeed = !bigFeed;
    applyFeedMode();
  },
  clear() { remarkBasket(); },
};

function resetFeedMode() {
  bigFeed = false;
  display.onFeedTap(null);
  applyFeedMode();
}

// ---- Best-effort fullscreen + landscape (needs the Start tap as a user gesture) ----

function enterFullscreen() {
  const root = document.documentElement;
  if (!root.requestFullscreen) return;
  root.requestFullscreen()
    .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
    .catch(() => { /* not allowed; the app still works in the browser frame */ });
}

function exitFullscreen() {
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (_) { /* ignore */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---- Session ----------------------------------------------------------------

async function releaseDevices() {
  outcome.stop();
  finder.stop();
  chains.close();
  cam.stopCamera(display.video);
  cam.stopMic();
  await cam.releaseWakeLock();
}

async function startSession({ heightIn } = {}) {
  enterFullscreen();
  chains.prepare(); // must happen inside the Start tap or Chrome keeps the AudioContext suspended
  setup.setBusy(true);
  tracker.reset();
  detector.reset();
  outcome.reset();
  clearRoundEndHold();
  tracker.setHeightIn(heightIn || CONFIG.HEIGHT_DEFAULT_IN);
  tracker.setBasketX(CONFIG.BASKET_X_NORM); // forget the last session's basket: the phone may have moved
  lastFrame = null;
  lastFlags = {};
  dispatch({ type: 'start', sessionId: `s${Date.now()}`, camera: false, audio: false });
  finder.clear();
  mark.begin(); // the TAP THE BASKET step is shown as soon as the camera is on
  pushBasketFlag();

  const stopped = () => state.screen === SCREEN.SETUP;
  try {
    await cam.startCamera(display.video, {
      onEnded: () => dispatch({ type: 'flags', patch: { camera: false } }),
    });
    if (stopped()) return releaseDevices();
    dispatch({ type: 'flags', patch: { camera: true } });
    pose.start(); // loads the model in the background; the feed read-out says MODEL LOADING
    const vStream = cam.getStreams().video;
    const vTrack = vStream ? vStream.getVideoTracks()[0] : null;
    outcome.start(vTrack); // disc watcher (in a worker when the browser allows): idles until a round is live
    if (CONFIG.BASKET_X_NORM == null) finder.start(display.video); // else the fixed x is used
  } catch (err) {
    console.warn('camera failed:', err);
  }
  try {
    await cam.startMic({ onEnded: () => dispatch({ type: 'flags', patch: { audio: false } }) });
    if (stopped()) return releaseDevices();
    await chains.attach(cam.getStreams().audio); // sets the audio flag through onStatus
  } catch (err) {
    console.warn('microphone failed:', err);
  }
  await cam.acquireWakeLock();
  if (stopped()) await releaseDevices();
  return undefined;
}

async function stopSession() {
  pose.stop();
  tracker.reset();
  detector.reset();
  outcome.reset();
  clearRoundEndHold();
  mark.cancel();
  resetFeedMode();
  dispatch({ type: 'stop' });
  exitFullscreen();
  await releaseDevices();
  setup.setBusy(false);
}

const display = createDisplay(screenRoot, {
  onStop: stopSession,
  onMarkTap: (x, y) => mark.tap(x, y),
  onMarkOk: () => mark.ok(),
  onMarkFix: () => mark.fix(),
  onRemark: remarkBasket,
});
const mark = createBasketMark({
  refine: (x, y) => finder.mark(x, y),
  aspect: () => (lastFrame ? lastFrame.w / lastFrame.h : (display.video.videoWidth / display.video.videoHeight) || 16 / 9),
  onChange: (v) => display.setMark(v),
  onCommit: (box) => finder.commit(box), // onFound -> tracker.setBasketX + basket flag
});
const outcome = createOutcomeTracker({ video: display.video, onVerdict });
const setup = renderSetup(setupRoot, { onStart: startSession });
const pose = createPose({
  video: display.video,
  onFrame: onPoseFrame,
  onStatus: (s) => { poseStatus = s; pushFeed(); },
});

if (DEBUG) {
  const { createDebugPanel } = await import('./debug.js');
  debugPanel = createDebugPanel(debugRoot, {
    dispatch,
    getState: () => state,
    getCameraInfo: cam.getCameraInfo,
    getTrack: () => ({ ...tracker.snapshot(), pose: pose.getStats() }),
    basketTools,
    throwTools,
    getThrows: detector.getInfo,
    getTrace: detector.getTrace,
  });
  setInterval(() => debugPanel.update(), 1000); // keeps the fps readout fresh
  debugRoot.classList.toggle('on-setup', state.screen === SCREEN.SETUP); // the app launches on SETUP
  const { createOutcomeDebug } = await import('./outcome-debug.js');
  createOutcomeDebug(debugRoot, {
    video: display.video, finder, chains, getStreams: cam.getStreams, outcome,
    getDiagnostics: () => ({
      pose: pose.getStats(),
      camera: cam.getCameraInfo(),
      swing: detector.getTrace(),
      throws: detector.getInfo(),
      state: {
        screen: state.screen,
        roundNumber: state.roundNumber,
        round: state.round,
        throws: state.throws,
        rounds: state.rounds,
      },
    }),
  });
}
