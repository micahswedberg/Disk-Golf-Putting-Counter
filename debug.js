// debug.js - ?debug=1 control panel. Loaded only in debug mode; normal mode never touches it.
// Fires simulated events into the state machine and shows the tracking readout.
// No detection logic lives here. Note: while the camera is running, real tracking overwrites the
// player / still toggles as soon as the real value changes.

import { CONFIG } from './config.js';
import { SCREEN } from './state.js';

const FLAG_NAMES = ['camera', 'audio', 'basket', 'player', 'stable'];

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Build the panel inside `root`.
 * Returns { update(), drawMotion() } - update() after every state change refreshes the readout;
 * drawMotion() redraws the wrist-speed trace (throws.js) and is cheap enough for every few frames.
 */
export function createDebugPanel(root, {
  dispatch, getState, getCameraInfo, getTrack, basketTools, throwTools, getThrows, getTrace,
}) {
  const sim = CONFIG.SIM;
  let simDistance = sim.startDistanceFt; // each round moves back a step

  function throwEvent(result) {
    const dist = Math.round(
      Math.min(CONFIG.DIST_MAX_FT, Math.max(CONFIG.DIST_MIN_FT, simDistance + rand(-1, 1))),
    );
    const maybe = (lo, hi) => (Math.random() < sim.unmeasuredChance ? null : Math.round(rand(lo, hi)));
    return {
      type: 'throw',
      result,
      distanceFt: dist,
      speedMph: maybe(...sim.speedMph),
      releaseAngleDeg: maybe(...sim.angleDeg),
      missDirection: result === 'miss' ? pick(sim.missDirections) : null,
      now: Date.now(),
    };
  }

  function roundEnd() {
    dispatch({ type: 'roundEnd' });
    if (getState().screen !== SCREEN.POST_ROUND) return; // nothing was thrown
    // Player leaves the throwing spot and walks to the basket.
    dispatch({ type: 'flags', patch: { player: false, stable: false } });
    simDistance += sim.stepFt;
    if (simDistance > CONFIG.DIST_MAX_FT) simDistance = sim.startDistanceFt;
  }

  const flags = (patch) => () => dispatch({ type: 'flags', patch });

  const ACTIONS = [
    ['Stable tracking', flags({ basket: true, player: true, stable: true })],
    ['Unstable tracking', flags({ player: true, stable: false })],
    ['Tracking lost', flags({ player: false, stable: false })],
    ['Ready', flags({ camera: true, audio: true, basket: true, player: true, stable: true })],
    ['Throw made', () => dispatch(throwEvent('make'))],
    ['Throw missed', () => dispatch(throwEvent('miss'))],
    ['Throw ignored', () => dispatch(throwEvent('ignored'))],
    ['Round end', roundEnd],
    ['Set basket (tap)', () => basketTools.toggleTap()],
    ['Clear basket', () => basketTools.clear()],
    ['Big cam', () => basketTools.toggleBig()],
  ];

  root.hidden = false;
  root.innerHTML = `
    <div class="dbg-bar"><button type="button" class="dbg-toggle">DBG</button><span class="dbg-state"></span></div>
    <div class="dbg-body">
      <div class="dbg-actions"></div>
      <div class="dbg-flags"></div>
      <canvas class="dbg-motion" width="320" height="90" style="width:100%;max-width:420px;display:block;margin-top:4px"></canvas>
      <pre class="dbg-read"></pre>
    </div>`;

  const body = root.querySelector('.dbg-body');
  const stateEl = root.querySelector('.dbg-state');
  const readEl = root.querySelector('.dbg-read');
  root.querySelector('.dbg-toggle').addEventListener('click', () => { body.hidden = !body.hidden; });

  const actionsEl = root.querySelector('.dbg-actions');
  for (const [label, fn] of ACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    actionsEl.appendChild(b);
  }

  // TEMPORARY (Phase 4): outcome given to every detected throw until make/miss detection exists.
  const outcomeBtn = document.createElement('button');
  outcomeBtn.type = 'button';
  outcomeBtn.addEventListener('click', () => throwTools.cycleOutcome());
  actionsEl.appendChild(outcomeBtn);

  const motionEl = root.querySelector('.dbg-motion');
  const mg = motionEl.getContext('2d');

  /** Wrist forward speed (both wrists), thresholds, and accepted / rejected swings. */
  function drawMotion() {
    if (body.hidden) return;
    const T = CONFIG.THROW;
    const { samples, events } = getTrace();
    const W = motionEl.width;
    const H = motionEl.height;
    mg.fillStyle = '#111';
    mg.fillRect(0, 0, W, H);
    const tEnd = samples.length ? samples[samples.length - 1].t : performance.now();
    const xOf = (t) => W * (1 - (tEnd - t) / T.TRACE_MS);
    const yOf = (v) => H - 4 - (Math.min(Math.max(v, 0), T.TRACE_MAX_SPEED) / T.TRACE_MAX_SPEED) * (H - 14);

    mg.lineWidth = 1;
    mg.setLineDash([4, 4]);
    mg.strokeStyle = '#666';
    mg.beginPath(); mg.moveTo(0, yOf(T.SPEED_START)); mg.lineTo(W, yOf(T.SPEED_START)); mg.stroke();
    mg.setLineDash([]);
    mg.strokeStyle = '#d33';
    mg.beginPath(); mg.moveTo(0, yOf(T.SPEED_MIN)); mg.lineTo(W, yOf(T.SPEED_MIN)); mg.stroke();

    for (const [key, color] of [['L', '#4dd'], ['R', '#fa3']]) {
      mg.strokeStyle = color;
      mg.lineWidth = 1.5;
      mg.beginPath();
      let pen = false;
      for (const s of samples) {
        const v = s.v[key];
        if (v == null) { pen = false; continue; }
        if (pen) mg.lineTo(xOf(s.t), yOf(v));
        else { mg.moveTo(xOf(s.t), yOf(v)); pen = true; }
      }
      mg.stroke();
    }

    mg.font = '10px monospace';
    for (const e of events) {
      if (tEnd - e.t > T.TRACE_MS) continue;
      const x = xOf(e.t);
      mg.strokeStyle = e.ok ? '#3d6' : '#888';
      mg.lineWidth = e.ok ? 2 : 1;
      mg.beginPath(); mg.moveTo(x, 12); mg.lineTo(x, H); mg.stroke();
      mg.fillStyle = e.ok ? '#3d6' : '#aaa';
      mg.fillText(e.ok ? 'THROW' : e.reason, Math.min(x + 2, W - 44), 10);
    }
    mg.fillStyle = '#888';
    mg.fillText(`cyan L \u00b7 orange R \u00b7 red = min speed \u00b7 ${T.TRACE_MS / 1000}s`, 2, H - 2);
  }

  const flagEls = {};
  const flagsEl = root.querySelector('.dbg-flags');
  for (const name of FLAG_NAMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.addEventListener('click', () => {
      dispatch({ type: 'flags', patch: { [name]: !getState().flags[name] } });
    });
    flagsEl.appendChild(b);
    flagEls[name] = b;
  }

  function update() {
    const s = getState();
    stateEl.textContent = s.screen + (s.reason ? ` \u00b7 ${s.reason}` : '');
    for (const name of FLAG_NAMES) {
      flagEls[name].textContent = `${name === 'stable' ? 'still' : name}: ${s.flags[name] ? '\u2713' : '\u2717'}`;
    }
    const cam = getCameraInfo();
    const camLine = cam
      ? `cam ${cam.width}x${cam.height} req ${cam.requested} \u00b7 rep ${cam.fps ?? '?'} fps \u00b7 meas ${cam.measuredFps ? cam.measuredFps.toFixed(1) : '?'} fps`
      : 'cam closed';
    const t = getTrack();
    const f = (v, d = 1) => (v == null ? '--' : v.toFixed(d));
    const yn = (v) => (v ? '\u2713' : '\u2717');
    const pose = t.pose || {};
    const trackLines = [
      `pose ${pose.status ?? '?'} \u00b7 ${pose.mode ?? '-'} \u00b7 ${f(pose.fps)} fps \u00b7 ${f(pose.inferMs, 0)} ms \u00b7 ${pose.delegate ?? '-'}`,
      `view ${t.view ?? '--'} (now ${t.viewNow ?? '--'}) \u00b7 detected ${yn(t.detected)} strict ${yn(t.strict)} relaxed ${yn(t.relaxed)}`,
      `upright ${yn(t.upright)} (tilt ${f(t.tilt, 0)}\u00b0 torso ${f(t.torsoRatio, 2)} head ${f(t.headRatio, 2)}) \u00b7 still ${yn(t.still)} (move ${f(t.spread == null ? null : t.spread * 100)}%) \u00b7 held ${f((t.heldMs || 0) / 1000)} s`,
      `feet x ${f(t.feetXn, 3)} \u00b7 basket x ${f(t.basketXn, 3)} \u00b7 anchor x ${f(t.anchorXn, 3)} (${f(t.anchorDistFt)} ft) \u00b7 body ${f(t.heightPx, 0)} px \u00b7 ${f(t.ftPerNormX)} ft/frame`,
      `DIST live ${f(t.distLiveFt)} ft \u00b7 toward ${f(t.towardFt)} ft \u00b7 away ${f(t.awayFt)} ft`,
    ];
    outcomeBtn.textContent = `Outcome (temp): ${throwTools.getOutcome()}`;
    const th = getThrows();
    const lv = th.live || {};
    const swingLines = th.recent.map((e) => (e.ok
      ? `  \u2713 ${e.arm} v ${f(e.peakV)} gain ${f(e.gain, 2)} ${e.dist ?? '--'} ft`
      : `  \u2717 ${e.reason} \u00b7 ${e.arm} v ${f(e.peakV)} gain ${f(e.gain, 2)} dir ${f(e.share, 2)}`));
    const throwLines = [
      `THROWS detected ${th.detected} this round \u00b7 outcome ${throwTools.getOutcome()}`,
      `v L ${f(lv.vL)} R ${f(lv.vR)} \u00b7 ext L ${f(lv.eL, 2)} R ${f(lv.eR, 2)} \u00b7 tilt ${f(lv.tilt, 0)}\u00b0 head ${f(lv.headRatio, 2)} hips ${f(lv.hipMove, 2)} off-spot ${f(lv.offSpotFt)} ft`,
      ...swingLines,
    ];
    readEl.textContent = [
      `round ${s.roundNumber} \u00b7 made ${s.round.made}/${s.round.counted} \u00b7 ignored ${s.round.ignored} \u00b7 lost ${s.lost}`,
      `session throws ${s.throws.length} \u00b7 rounds closed ${s.rounds.length} \u00b7 sim dist ${simDistance} ft`,
      camLine,
      ...trackLines,
      ...throwLines,
    ].join('\n');
    drawMotion();
  }

  update();
  return { update, drawMotion };
}
