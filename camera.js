// camera.js - Phase 1 camera test: resolution, measured fps, wake lock, mic level.

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), placeholder: $('placeholder'), toggle: $('toggle'),
  requested: $('requested'), resolution: $('resolution'),
  settingsFps: $('settingsFps'), measuredFps: $('measuredFps'),
  cameraName: $('cameraName'), wakeLock: $('wakeLock'), mic: $('mic'),
  meterFill: $('meterFill'), meterText: $('meterText'), log: $('log'),
};

/** Show text with an ok/warn/bad colour class. */
function setStatus(el, text, cls = '') {
  el.textContent = text;
  el.className = cls;
}

function log(msg) {
  els.log.textContent += msg + '\n';
}

// ---- Camera ---------------------------------------------------------------

/** Constraint attempts, best first. */
const ATTEMPTS = [
  { label: '1920x1080 @60', w: 1920, h: 1080, fps: 60 },
  { label: '1920x1080 @30', w: 1920, h: 1080, fps: 30 },
  { label: '1280x720 @60', w: 1280, h: 720, fps: 60 },
  { label: '1280x720 @30', w: 1280, h: 720, fps: 30 },
  { label: 'browser default', w: null, h: null, fps: null },
];

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
 * Open the front camera, trying each attempt in turn.
 * Returns { stream, attempt } or throws if every attempt fails.
 */
async function openCamera() {
  let lastErr;
  for (const attempt of ATTEMPTS) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(buildConstraints(attempt));
      log('Opened with request: ' + attempt.label);
      return { stream, attempt };
    } catch (err) {
      log(`Failed (${attempt.label}): ${err.name}`);
      lastErr = err;
      if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') break;
    }
  }
  throw lastErr;
}

function reportSettings(stream, attempt) {
  const track = stream.getVideoTracks()[0];
  const s = track.getSettings();
  const wantsHD = attempt.w === 1920 && attempt.fps === 60;
  els.requested.textContent = attempt.label;
  const gotHD = s.width === 1920 && s.height === 1080;
  setStatus(els.resolution, `${s.width} x ${s.height}`, gotHD ? 'ok' : 'warn');
  setStatus(els.settingsFps, s.frameRate ? `${Math.round(s.frameRate)} fps` : 'n/a',
    s.frameRate >= 59 ? 'ok' : 'warn');
  els.cameraName.textContent = track.label || 'unknown';
  if (!wantsHD) log('Note: 1080p60 was not granted; fell back.');
  try {
    const c = track.getCapabilities ? track.getCapabilities() : null;
    if (c && c.frameRate) log(`Capability fps max: ${c.frameRate.max}`);
    if (c && c.width) log(`Capability width max: ${c.width.max}`);
  } catch (_) { /* capabilities not supported */ }
}

// ---- FPS measurement ------------------------------------------------------

const FPS_WINDOW_MS = 3000;
let fpsRunning = false;

/** Measure delivered frame rate over a rolling window via requestVideoFrameCallback. */
function startFpsMeter(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    setStatus(els.measuredFps, 'rVFC unsupported', 'warn');
    return;
  }
  fpsRunning = true;
  const samples = []; // { t, frames }
  let callbackCount = 0;
  const tick = (now, meta) => {
    if (!fpsRunning) return;
    callbackCount++;
    const frames = typeof meta.presentedFrames === 'number' ? meta.presentedFrames : callbackCount;
    samples.push({ t: now, frames });
    while (samples.length > 2 && now - samples[0].t > FPS_WINDOW_MS) samples.shift();
    if (samples.length > 1) {
      const a = samples[0];
      const b = samples[samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt >= 1) {
        const fps = (b.frames - a.frames) / dt;
        setStatus(els.measuredFps, `${fps.toFixed(1)} fps`, fps >= 55 ? 'ok' : fps >= 28 ? 'warn' : 'bad');
      }
    }
    video.requestVideoFrameCallback(tick);
  };
  setStatus(els.measuredFps, 'measuring...', 'warn');
  video.requestVideoFrameCallback(tick);
}

function stopFpsMeter() {
  fpsRunning = false;
}

// ---- Wake lock ------------------------------------------------------------

let wakeLock = null;
let wantWakeLock = false;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    setStatus(els.wakeLock, 'unsupported', 'bad');
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    setStatus(els.wakeLock, 'active', 'ok');
    wakeLock.addEventListener('release', () => {
      if (wantWakeLock) setStatus(els.wakeLock, 'released', 'warn');
    });
  } catch (err) {
    setStatus(els.wakeLock, `failed (${err.name})`, 'bad');
  }
}

async function releaseWakeLock() {
  wantWakeLock = false;
  try { if (wakeLock) await wakeLock.release(); } catch (_) { /* ignore */ }
  wakeLock = null;
  setStatus(els.wakeLock, '-');
}

// The browser drops the lock when the tab is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (wantWakeLock && document.visibilityState === 'visible') acquireWakeLock();
});

// ---- Microphone level -----------------------------------------------------

let audioCtx = null;
let audioStream = null;
let meterRaf = 0;

const DB_FLOOR = -60;

async function startAudioMeter() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    setStatus(els.mic, `unavailable (${err.name})`, 'bad');
    els.meterText.textContent = 'no audio';
    return;
  }
  const track = audioStream.getAudioTracks()[0];
  const s = track.getSettings();
  const flags = `AGC ${s.autoGainControl ? 'on' : 'off'}, NS ${s.noiseSuppression ? 'on' : 'off'}, EC ${s.echoCancellation ? 'on' : 'off'}`;
  setStatus(els.mic, 'open', 'ok');
  log(`Mic: ${track.label || 'unknown'} (${flags})`);

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const source = audioCtx.createMediaStreamSource(audioStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let peakHold = DB_FLOOR;
  let peakAt = 0;

  const draw = (now) => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      sum += v * v;
      if (v > peak) peak = v;
    }
    const rmsDb = Math.max(DB_FLOOR, 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6));
    const peakDb = Math.max(DB_FLOOR, 20 * Math.log10(peak || 1e-6));
    if (peakDb >= peakHold || now - peakAt > 1500) { peakHold = peakDb; peakAt = now; }
    const pct = ((rmsDb - DB_FLOOR) / -DB_FLOOR) * 100;
    els.meterFill.style.width = pct.toFixed(0) + '%';
    els.meterText.textContent = `RMS ${rmsDb.toFixed(0)} dBFS · peak hold ${peakHold.toFixed(0)} dBFS`;
    meterRaf = requestAnimationFrame(draw);
  };
  meterRaf = requestAnimationFrame(draw);
}

function stopAudioMeter() {
  cancelAnimationFrame(meterRaf);
  if (audioStream) audioStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  audioStream = null;
  audioCtx = null;
  els.meterFill.style.width = '0';
  els.meterText.textContent = '-';
  setStatus(els.mic, '-');
}

// ---- Start / stop ---------------------------------------------------------

let cameraStream = null;

async function start() {
  els.log.textContent = '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus(els.resolution, 'camera API unavailable (needs HTTPS)', 'bad');
    return;
  }
  els.toggle.disabled = true;
  try {
    const { stream, attempt } = await openCamera();
    cameraStream = stream;
    els.video.srcObject = stream;
    await els.video.play().catch(() => {});
    els.placeholder.hidden = true;
    reportSettings(stream, attempt);
    startFpsMeter(els.video);
  } catch (err) {
    setStatus(els.resolution, `NO CAMERA (${err.name})`, 'bad');
    els.toggle.disabled = false;
    return;
  }
  wantWakeLock = true;
  await acquireWakeLock();
  await startAudioMeter();
  els.toggle.textContent = 'Stop';
  els.toggle.className = 'stop';
  els.toggle.disabled = false;
}

async function stop() {
  stopFpsMeter();
  stopAudioMeter();
  await releaseWakeLock();
  if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  els.video.srcObject = null;
  els.placeholder.hidden = false;
  els.toggle.textContent = 'Start';
  els.toggle.className = '';
}

els.toggle.addEventListener('click', () => (cameraStream ? stop() : start()));
