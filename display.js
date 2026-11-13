// display.js - renders every session screen state, plus the contrast helper.
// Setup screen lives in setup.js.

import { CONFIG } from './config.js';
import { SCREEN, bucketStats, makePct } from './state.js';

// ---- Contrast helper ------------------------------------------------------

function parseHex(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours (1..21). */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** '#ffffff' or '#000000', whichever has the higher contrast against bg. Ties go to black. */
export function pickTextColor(bg) {
  return contrastRatio(bg, '#ffffff') > contrastRatio(bg, '#000000') ? '#ffffff' : '#000000';
}

// ---- Formatting -----------------------------------------------------------

/** "27 ft · 31 mph · 14°" with "--" for unmeasured values. */
function formatDetail(f) {
  const ft = f.distanceFt == null ? '--' : Math.round(f.distanceFt);
  const mph = f.speedMph == null ? '--' : Math.round(f.speedMph);
  const deg = f.releaseAngleDeg == null ? '--' : Math.round(f.releaseAngleDeg);
  return `${ft} ft \u00b7 ${mph} mph \u00b7 ${deg}\u00b0`;
}

// ---- Screen -----------------------------------------------------------------

const TEMPLATE = `
  <div class="view v-notready">
    <svg class="warn" viewBox="0 0 100 90" aria-hidden="true">
      <path d="M50 5 L96 85 H4 Z" fill="currentColor" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/>
      <rect x="45" y="30" width="10" height="30" rx="3" style="fill:var(--bg)"/>
      <circle cx="50" cy="71" r="6" style="fill:var(--bg)"/>
    </svg>
    <div class="reason"></div>
  </div>

  <div class="view v-live">
    <div class="live-main">
      <div class="round-label"></div>
      <div class="big"></div>
      <div class="big-label">MADE / THROWN</div>
    </div>
    <div class="strip"></div>
  </div>

  <div class="view v-flash">
    <div class="flash-title"></div>
    <div class="flash-detail"></div>
    <div class="flash-dir"></div>
  </div>

  <div class="view v-post">
    <div class="post-title"></div>
    <div class="post-big"></div>
    <div class="post-pct"></div>
    <div class="post-sub"></div>
  </div>

  <video class="corner" muted playsinline autoplay></video>
  <button class="stop" type="button">Stop</button>
`;

/**
 * Build the session screen inside `root`.
 * Returns { render(state), video } - video is the mirrored corner feed element.
 */
export function createDisplay(root, { onStop }) {
  root.innerHTML = TEMPLATE;
  const q = (sel) => root.querySelector(sel);
  const el = {
    reason: q('.reason'),
    roundLabel: q('.round-label'),
    big: q('.big'),
    strip: q('.strip'),
    flashTitle: q('.flash-title'),
    flashDetail: q('.flash-detail'),
    flashDir: q('.flash-dir'),
    postTitle: q('.post-title'),
    postBig: q('.post-big'),
    postPct: q('.post-pct'),
    postSub: q('.post-sub'),
  };

  // Bucket strip rows, built once.
  const rows = [];
  for (let i = 0; i < CONFIG.BUCKET_COUNT; i++) {
    const lo = CONFIG.BUCKET_MIN_FT + i * CONFIG.BUCKET_SIZE_FT;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="lo">${lo}\u2013${lo + CONFIG.BUCKET_SIZE_FT}</span><span class="pct">\u2013</span>`;
    el.strip.appendChild(row);
    rows.push(row.querySelector('.pct'));
  }

  q('.stop').addEventListener('click', onStop);

  function renderLive(state) {
    el.roundLabel.textContent = `ROUND ${state.roundNumber}`;
    el.big.textContent = `${state.round.made}/${state.round.counted}`;
    const stats = bucketStats(state.throws);
    stats.forEach((b, i) => {
      rows[i].textContent = b.pct === null ? '\u2013' : `${b.pct}%`;
    });
  }

  function renderFlash(state) {
    const made = state.screen === SCREEN.FLASH_MADE;
    el.flashTitle.textContent = made ? 'Chains!' : 'MISS';
    el.flashDetail.textContent = formatDetail(state.flash);
    const dir = state.flash.missDirection;
    el.flashDir.textContent = !made && dir ? dir.toUpperCase() : '';
  }

  function renderPost(state) {
    const r = state.lastRound;
    if (!r) return;
    const pct = makePct(r.made, r.thrown);
    el.postTitle.textContent = `ROUND ${r.roundNumber} DONE`;
    el.postBig.textContent = `${r.made}/${r.thrown}`;
    el.postPct.textContent = `${pct === null ? '--' : pct}% \u00b7 ${r.distanceFt === null ? '--' : r.distanceFt} ft`;
    el.postSub.textContent = `${r.thrown + r.ignored} thrown, ${r.thrown} counted, ${r.ignored} ignored`;
  }

  function render(state) {
    const bg = CONFIG.COLORS[state.screen];
    if (!bg) return;
    root.style.setProperty('--bg', bg);
    root.style.setProperty('--fg', pickTextColor(bg));
    root.dataset.screen = state.screen;
    switch (state.screen) {
      case SCREEN.NOT_READY:
        el.reason.textContent = state.reason;
        break;
      case SCREEN.LIVE:
        renderLive(state);
        break;
      case SCREEN.FLASH_MADE:
      case SCREEN.FLASH_MISS:
        renderFlash(state);
        break;
      case SCREEN.POST_ROUND:
        renderPost(state);
        break;
      default:
        break;
    }
  }

  return { render, video: q('.corner') };
}
