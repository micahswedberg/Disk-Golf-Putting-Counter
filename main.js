// main.js - wires setup, state machine, display, camera and (debug only) the simulator.

import { CONFIG } from './config.js';
import { SCREEN, createState, reduce, isFlash } from './state.js';
import { createDisplay } from './display.js';
import { renderSetup } from './setup.js';
import * as cam from './camera.js';

const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

const setupRoot = document.getElementById('setup');
const screenRoot = document.getElementById('screen');
const debugRoot = document.getElementById('debug');

let state = createState();
let flashTimer = 0;
let seenFlashId = 0;
let debugPanel = null;

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

async function startSession() {
  enterFullscreen();
  setup.setBusy(true);
  dispatch({ type: 'start', sessionId: `s${Date.now()}`, camera: false, audio: false });

  const stopped = () => state.screen === SCREEN.SETUP;
  try {
    await cam.startCamera(display.video, {
      onEnded: () => dispatch({ type: 'flags', patch: { camera: false } }),
    });
    if (stopped()) return releaseDevices();
    dispatch({ type: 'flags', patch: { camera: true } });
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
  dispatch({ type: 'stop' });
  exitFullscreen();
  await releaseDevices();
  setup.setBusy(false);
}

const display = createDisplay(screenRoot, { onStop: stopSession });
const setup = renderSetup(setupRoot, { onStart: startSession });

if (DEBUG) {
  const { createDebugPanel } = await import('./debug.js');
  debugPanel = createDebugPanel(debugRoot, {
    dispatch,
    getState: () => state,
    getCameraInfo: cam.getCameraInfo,
  });
  setInterval(() => debugPanel.update(), 1000); // keeps the fps readout fresh
}
