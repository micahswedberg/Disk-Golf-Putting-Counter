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
 * Returns { update() } - call after every state change to refresh the readout.
 */
export function createDebugPanel(root, { dispatch, getState, getCameraInfo, getTrack, basketTools }) {
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
    readEl.textContent = [
      `round ${s.roundNumber} \u00b7 made ${s.round.made}/${s.round.counted} \u00b7 ignored ${s.round.ignored} \u00b7 lost ${s.lost}`,
      `session throws ${s.throws.length} \u00b7 rounds closed ${s.rounds.length} \u00b7 sim dist ${simDistance} ft`,
      camLine,
      ...trackLines,
    ].join('\n');
  }

  update();
  return { update };
}
