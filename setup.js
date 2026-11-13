// setup.js - startup screen shown on every launch: two diagrams, height field, Start button.

import { CONFIG } from './config.js';

/** Last saved height in inches, or the default. */
export function loadHeightIn() {
  try {
    const v = parseFloat(localStorage.getItem(CONFIG.STORAGE.height));
    if (v >= CONFIG.HEIGHT_MIN_IN && v <= CONFIG.HEIGHT_MAX_IN) return v;
  } catch (_) { /* storage blocked */ }
  return CONFIG.HEIGHT_DEFAULT_IN;
}

function saveHeightIn(v) {
  try { localStorage.setItem(CONFIG.STORAGE.height, String(v)); } catch (_) { /* ignore */ }
}

const TOP_DOWN_SVG = `
<svg viewBox="0 0 400 200" role="img" aria-label="Top-down view of the putt line and phone">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
    </marker>
  </defs>
  <polygon points="200,142 24,40 376,40" fill="#1a5cff" opacity="0.13"/>
  <line x1="40" y1="40" x2="360" y2="40" stroke="currentColor" stroke-width="4"/>
  <g stroke="currentColor" stroke-width="2">
    <line x1="120" y1="34" x2="120" y2="46"/><line x1="200" y1="34" x2="200" y2="46"/>
    <line x1="280" y1="34" x2="280" y2="46"/><line x1="360" y1="34" x2="360" y2="46"/>
  </g>
  <g font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">
    <text x="120" y="62">10</text><text x="200" y="62">20</text>
    <text x="280" y="62">30</text><text x="360" y="62">40 ft</text>
    <text x="40" y="20">BASKET</text>
  </g>
  <circle cx="40" cy="40" r="11" fill="#ffb000" stroke="currentColor" stroke-width="3"/>
  <line x1="200" y1="136" x2="200" y2="76" stroke="currentColor" stroke-width="2.5" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text x="208" y="112" font-size="12" font-weight="700" fill="currentColor">square to line</text>
  <rect x="176" y="142" width="48" height="9" rx="2" fill="currentColor"/>
  <circle cx="200" cy="142" r="3.5" fill="#ffb000" stroke="currentColor" stroke-width="1.5"/>
  <text x="200" y="172" font-size="13" font-weight="800" fill="currentColor" text-anchor="middle">PHONE, landscape, at midpoint</text>
  <text x="200" y="190" font-size="12" fill="currentColor" text-anchor="middle">screen + front camera face the line</text>
  <line x1="346" y1="48" x2="346" y2="138" stroke="currentColor" stroke-width="2" marker-start="url(#arr)" marker-end="url(#arr)"/>
  <text x="340" y="96" font-size="12" font-weight="800" fill="currentColor" text-anchor="end">25\u201330 ft</text>
</svg>`;

const SIDE_SVG = `
<svg viewBox="0 0 400 200" role="img" aria-label="Side view of phone height and tilt">
  <polygon points="320,118 40,48 40,178" fill="#1a5cff" opacity="0.13"/>
  <line x1="8" y1="178" x2="392" y2="178" stroke="currentColor" stroke-width="3"/>
  <line x1="50" y1="178" x2="50" y2="116" stroke="currentColor" stroke-width="4"/>
  <rect x="34" y="100" width="32" height="16" rx="3" fill="#ffb000" stroke="currentColor" stroke-width="2.5"/>
  <text x="50" y="194" font-size="12" font-weight="800" fill="currentColor" text-anchor="middle">BASKET</text>
  <g stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round">
    <circle cx="180" cy="94" r="8"/>
    <line x1="180" y1="102" x2="180" y2="140"/>
    <line x1="180" y1="140" x2="172" y2="178"/><line x1="180" y1="140" x2="188" y2="178"/>
    <line x1="180" y1="114" x2="167" y2="132"/><line x1="180" y1="114" x2="193" y2="132"/>
  </g>
  <text x="180" y="194" font-size="12" font-weight="800" fill="currentColor" text-anchor="middle">YOU</text>
  <line x1="320" y1="178" x2="320" y2="136" stroke="currentColor" stroke-width="3"/>
  <rect x="314" y="102" width="12" height="34" rx="3" fill="currentColor"/>
  <circle cx="314" cy="118" r="2.5" fill="#ffb000"/>
  <text x="320" y="194" font-size="12" font-weight="800" fill="currentColor" text-anchor="middle">PHONE</text>
  <line x1="308" y1="118" x2="76" y2="118" stroke="currentColor" stroke-width="2.5" stroke-dasharray="5 4" marker-end="url(#arr)"/>
  <text x="195" y="76" font-size="12" font-weight="800" fill="currentColor" text-anchor="middle">level, no tilt</text>
  <line x1="356" y1="178" x2="356" y2="118" stroke="currentColor" stroke-width="2" marker-start="url(#arr)" marker-end="url(#arr)"/>
  <text x="362" y="146" font-size="12" font-weight="800" fill="currentColor">chest</text>
  <text x="362" y="160" font-size="12" font-weight="800" fill="currentColor">height</text>
  <text x="200" y="20" font-size="12" fill="currentColor" text-anchor="middle">whole line + basket in frame</text>
</svg>`;

const TEMPLATE = `
  <header class="setup-head"><h1>Putting tracker: set up the phone</h1></header>
  <div class="diagrams">
    <figure class="card"><figcaption>Top view</figcaption>${TOP_DOWN_SVG}</figure>
    <figure class="card"><figcaption>Side view</figcaption>${SIDE_SVG}</figure>
  </div>
  <div class="setup-foot">
    <label for="heightIn">Your height (inches)</label>
    <input id="heightIn" type="number" inputmode="decimal" min="${CONFIG.HEIGHT_MIN_IN}" max="${CONFIG.HEIGHT_MAX_IN}" step="0.5">
    <span id="heightHint"></span>
    <span id="setupMsg" role="status"></span>
    <button id="startBtn" type="button">Start</button>
  </div>
`;

/**
 * Render the startup screen into `root`.
 * onStart({ heightIn }) is called from the Start tap (a user gesture).
 * Returns { setBusy(bool, msg), showMessage(msg) }.
 */
export function renderSetup(root, { onStart }) {
  root.innerHTML = TEMPLATE;
  const input = root.querySelector('#heightIn');
  const hint = root.querySelector('#heightHint');
  const msg = root.querySelector('#setupMsg');
  const btn = root.querySelector('#startBtn');

  const updateHint = () => {
    const v = parseFloat(input.value);
    hint.textContent = v > 0 ? `${Math.floor(v / 12)} ft ${Math.round(v % 12)} in` : '';
  };
  input.value = loadHeightIn();
  updateHint();
  input.addEventListener('input', updateHint);

  btn.addEventListener('click', () => {
    const v = parseFloat(input.value);
    if (!(v >= CONFIG.HEIGHT_MIN_IN && v <= CONFIG.HEIGHT_MAX_IN)) {
      msg.textContent = `Enter a height from ${CONFIG.HEIGHT_MIN_IN} to ${CONFIG.HEIGHT_MAX_IN} inches.`;
      input.focus();
      return;
    }
    msg.textContent = '';
    saveHeightIn(v);
    onStart({ heightIn: v });
  });

  return {
    setBusy(busy, text = '') {
      btn.disabled = busy;
      msg.textContent = text;
    },
    showMessage(text) { msg.textContent = text; },
  };
}
