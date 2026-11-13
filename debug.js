// debug.js - ?debug=1 control panel. Loaded only in debug mode; normal mode never touches it.
// Fires simulated events into the state machine. No detection logic lives here.

import { CONFIG } from './config.js';
import { SCREEN } from './state.js';

const FLAG_NAMES = ['camera', 'audio', 'basket', 'player', 'stable'];

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Build the panel inside `root`.
 * Returns { update() } - call after every state change to refresh the readout.
 */
export function createDebugPanel(root, { dispatch, getState, getCameraInfo }) {
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
    readEl.textContent = [
      `round ${s.roundNumber} \u00b7 made ${s.round.made}/${s.round.counted} \u00b7 ignored ${s.round.ignored} \u00b7 lost ${s.lost}`,
      `session throws ${s.throws.length} \u00b7 rounds closed ${s.rounds.length} \u00b7 sim dist ${simDistance} ft`,
      camLine,
    ].join('\n');
  }

  update();
  return { update };
}
