// main.js - wires setup, state machine, display, camera, pose tracking and (debug only) the simulator.

import { CONFIG } from './config.js';
import { SCREEN, createState, reduce, isFlash } from './state.js';
import { createDisplay } from './display.js';
import { renderSetup } from './setup.js';
import * as cam from './camera.js';
import { createPose } from './pose.js';
import { createRoundTracker } from './round.js';

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
let tapArmed = false;

/** Send an event through the state machine, then render and schedule flash expiry. */
function dispatch(ev) {
  const next = reduce(state, ev);
  if (next === state) return;
  state = next;

  const inSetup = state.screen === SCREEN.SETUP;
  setupRoot.hidden = !inSetup;
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

function pushBasketFlag() {
  syncFlags({ basket: tracker.getBasketX() != null });
  pushFeed();
}

/** Refresh the corner feed (basket marker, read-out of what is missing, debug landmarks). */
function pushFeed() {
  const snap = tracker.snapshot();
  display.updateFeed({
    aspect: lastFrame ? lastFrame.w / lastFrame.h : null,
    landmarks: lastFrame ? lastFrame.landmarks : null,
    basketX: tracker.getBasketX(),
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
  const now = performance.now();
  const out = tracker.update(frame, now, state);
  syncFlags({ player: out.flags.player, stable: out.flags.stable });
  if (out.roundEnd) dispatch({ type: 'roundEnd' });
  pushFeed();
  if (debugPanel && now - lastDebugAt > 200) {
    lastDebugAt = now;
    debugPanel.update();
  }
}

// ---- Debug: basket placement (tap the enlarged feed) ----------------------------

function applyFeedMode() {
  display.setFeedLarge(bigFeed || tapArmed, tapArmed);
}

function onBasketTap(x) {
  tracker.setBasketX(x);
  tapArmed = false;
  display.onFeedTap(null);
  applyFeedMode();
  pushBasketFlag();
}

const basketTools = {
  toggleTap() {
    tapArmed = !tapArmed;
    display.onFeedTap(tapArmed ? onBasketTap : null);
    applyFeedMode();
  },
  toggleBig() {
    bigFeed = !bigFeed;
    applyFeedMode();
  },
  clear() {
    tracker.setBasketX(null);
    pushBasketFlag();
  },
};

function resetFeedMode() {
  bigFeed = false;
  tapArmed = false;
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
  cam.stopCamera(display.video);
  cam.stopMic();
  await cam.releaseWakeLock();
}

async function startSession({ heightIn } = {}) {
  enterFullscreen();
  setup.setBusy(true);
  tracker.reset();
  tracker.setHeightIn(heightIn || CONFIG.HEIGHT_DEFAULT_IN);
  lastFrame = null;
  lastFlags = {};
  dispatch({ type: 'start', sessionId: `s${Date.now()}`, camera: false, audio: false });
  pushBasketFlag();

  const stopped = () => state.screen === SCREEN.SETUP;
  try {
    await cam.startCamera(display.video, {
      onEnded: () => dispatch({ type: 'flags', patch: { camera: false } }),
    });
    if (stopped()) return releaseDevices();
    dispatch({ type: 'flags', patch: { camera: true } });
    pose.start(); // loads the model in the background; the feed read-out says MODEL LOADING
  } catch (err) {
    console.warn('camera failed:', err);
  }
  try {
    await cam.startMic({ onEnded: () => dispatch({ type: 'flags', patch: { audio: false } }) });
    if (stopped()) return releaseDevices();
    dispatch({ type: 'flags', patch: { audio: true } });
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
  resetFeedMode();
  dispatch({ type: 'stop' });
  exitFullscreen();
  await releaseDevices();
  setup.setBusy(false);
}

const display = createDisplay(screenRoot, { onStop: stopSession });
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
  });
  setInterval(() => debugPanel.update(), 1000); // keeps the fps readout fresh
}
