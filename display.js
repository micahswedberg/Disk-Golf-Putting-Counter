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

// ---- Camera feed read-out ---------------------------------------------------

const VIEW_TEXT = {
  none: 'NO PLAYER',
  head: 'HEAD CUT OFF',
  feet: 'FEET CUT OFF',
  side: 'SIDE CUT OFF',
  weak: 'PLAYER UNCLEAR',
};

// Skeleton segments drawn in ?debug=1 (MediaPipe landmark indices).
const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [28, 30], [30, 32], [0, 11], [0, 12],
];

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

  <div class="feed">
    <video class="corner" muted playsinline autoplay></video>
    <canvas class="feed-ov"></canvas>
    <div class="feed-readout"></div>
  </div>
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
  const feed = q('.feed');
  const ov = q('.feed-ov');
  const ovCtx = ov.getContext('2d');
  const readout = q('.feed-readout');
  let feedAspect = 16 / 9;
  let readoutKey = '';
  let tapFn = null;

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
    el.postTitle.textContent = r.empty ? 'NO THROWS' : `ROUND ${r.roundNumber} DONE`;
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

  // ---- Camera feed: basket marker, what is missing, debug landmarks ----------

  feed.addEventListener('click', (e) => {
    if (!tapFn) return;
    const r = feed.getBoundingClientRect();
    // The feed is shown mirrored; tap x is converted back to raw camera-frame x.
    tapFn(Math.min(1, Math.max(0, 1 - (e.clientX - r.left) / r.width)));
  });

  function drawFeed({ landmarks, basketX, anchorX, feetX, debug }) {
    const W = ov.width;
    const H = ov.height;
    ovCtx.clearRect(0, 0, W, H);
    const vline = (xn, color, width, dash) => {
      ovCtx.setLineDash(dash);
      ovCtx.strokeStyle = color;
      ovCtx.lineWidth = width;
      ovCtx.beginPath();
      ovCtx.moveTo(xn * W, 0);
      ovCtx.lineTo(xn * W, H);
      ovCtx.stroke();
    };
    if (basketX != null) {
      vline(basketX, '#000', 6, []);
      vline(basketX, '#ffb000', 3, [10, 6]);
    }
    if (!debug) return;
    if (anchorX != null) vline(anchorX, '#00d84a', 2, [4, 4]);
    if (feetX != null) vline(feetX, '#00e5ff', 2, []);
    ovCtx.setLineDash([]);
    if (!landmarks) return;
    ovCtx.lineWidth = 2;
    ovCtx.strokeStyle = '#ff00ff';
    for (const [a, b] of BONES) {
      const p = landmarks[a];
      const r = landmarks[b];
      if (p.visibility < 0.3 || r.visibility < 0.3) continue;
      ovCtx.beginPath();
      ovCtx.moveTo(p.x * W, p.y * H);
      ovCtx.lineTo(r.x * W, r.y * H);
      ovCtx.stroke();
    }
    for (const i of [0, 11, 12, 23, 24, 27, 28, 29, 30, 31, 32]) {
      const p = landmarks[i];
      ovCtx.fillStyle = p.visibility >= 0.5 ? '#ffe100' : '#ff3030';
      ovCtx.fillRect(p.x * W - 2, p.y * H - 2, 4, 4);
    }
  }

  /**
   * Refresh the corner feed. Called on every pose frame (and on pose status changes).
   * info = { aspect, landmarks, basketX, anchorX, feetX, view, poseStatus, debug }
   * The read-out lists what is missing from the picture: model status, basket, player.
   */
  function updateFeed(info) {
    if (info.aspect && Math.abs(info.aspect - feedAspect) > 0.01) {
      feedAspect = info.aspect;
      feed.style.aspectRatio = String(feedAspect);
    }
    const ovH = Math.round(320 / feedAspect);
    if (ov.width !== 320 || ov.height !== ovH) { ov.width = 320; ov.height = ovH; }
    drawFeed(info);

    const items = [];
    if (info.poseStatus === 'loading') items.push('MODEL LOADING');
    else if (info.poseStatus === 'failed') items.push('MODEL FAILED');
    if (info.basketX == null) items.push('NO BASKET');
    if (info.poseStatus === 'ready' && VIEW_TEXT[info.view]) items.push(VIEW_TEXT[info.view]);
    const key = items.join('|');
    if (key !== readoutKey) {
      readoutKey = key;
      readout.replaceChildren(...items.map((t) => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.textContent = t;
        return chip;
      }));
      feed.classList.toggle('alert', items.length > 0);
    }
  }

  /** Debug: enlarge the feed (optionally tappable). */
  function setFeedLarge(on, tappable = false) {
    feed.classList.toggle('feed-large', on);
    feed.classList.toggle('tap', on && tappable);
  }

  /** Debug: tap handler receiving raw-frame x (0..1); pass null to clear. */
  function onFeedTap(fn) { tapFn = fn; }

  return { render, video: q('.corner'), updateFeed, setFeedLarge, onFeedTap };
}
