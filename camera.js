// camera.js - getUserMedia (front camera), reported resolution and fps, wake lock, mic.
// Phase 2: refactored from the Phase 1 test page into a DOM-free module.

import { CONFIG } from './config.js';

let cameraStream = null;
let cameraInfo = null;
let measuredFps = null;
let fpsRunning = false;

let micStream = null;

let wakeLock = null;
let wantWakeLock = false;

// ---- Camera ---------------------------------------------------------------

function buildConstraints(a) {
  const video = { facingMode: 'user' };
  if (a.w) {
    video.width = { ideal: a.w };
    video.height = { ideal: a.h };
    video.frameRate = { ideal: a.fps };
  }
  return { video, audio: false };
}

/**
 * Open the front camera into `video`, trying each CONFIG.CAMERA_REQUESTS entry.
 * Resolves with the info actually delivered (never the requested values).
 * onEnded fires if the camera track stops unexpectedly.
 */
export async function startCamera(video, { onEnded } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('camera API unavailable (needs HTTPS)');
  }
  let stream = null;
  let used = null;
  let lastErr;
  for (const attempt of CONFIG.CAMERA_REQUESTS) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(buildConstraints(attempt));
      used = attempt;
      break;
    } catch (err) {
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') break;
    }
  }
  if (!stream) throw lastErr;

  cameraStream = stream;
  video.srcObject = stream;
  await video.play().catch(() => {});

  const track = stream.getVideoTracks()[0];
  const s = track.getSettings();
  cameraInfo = {
    requested: used.label,
    width: s.width,
    height: s.height,
    fps: s.frameRate ? Math.round(s.frameRate) : null,
    label: track.label || 'unknown',
  };
  track.addEventListener('ended', () => { if (onEnded) onEnded(); });
  startFpsMeter(video);
  return cameraInfo;
}

export function stopCamera(video) {
  fpsRunning = false;
  measuredFps = null;
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  cameraInfo = null;
  if (video) video.srcObject = null;
}

/** Delivered camera info plus measured fps, or null when the camera is closed. */
export function getCameraInfo() {
  return cameraInfo ? { ...cameraInfo, measuredFps } : null;
}

function startFpsMeter(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
  fpsRunning = true;
  const samples = [];
  let count = 0;
  const tick = (now, meta) => {
    if (!fpsRunning) return;
    count += 1;
    const frames = typeof meta.presentedFrames === 'number' ? meta.presentedFrames : count;
    samples.push({ t: now, frames });
    while (samples.length > 2 && now - samples[0].t > CONFIG.FPS_WINDOW_MS) samples.shift();
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt >= 1) measuredFps = (b.frames - a.frames) / dt;
    video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
}

// ---- Microphone (open-and-confirm only; the audio spike detector comes later) --

export async function startMic({ onEnded } = {}) {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const track = micStream.getAudioTracks()[0];
  track.addEventListener('ended', () => { if (onEnded) onEnded(); });
  return track.label || 'unknown';
}

export function stopMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
}

// ---- Wake lock --------------------------------------------------------------

export async function acquireWakeLock() {
  wantWakeLock = true;
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    return true;
  } catch (_) {
    return false;
  }
}

export async function releaseWakeLock() {
  wantWakeLock = false;
  try { if (wakeLock) await wakeLock.release(); } catch (_) { /* ignore */ }
  wakeLock = null;
}

// The browser drops the lock when the tab is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (wantWakeLock && document.visibilityState === 'visible') acquireWakeLock();
});
