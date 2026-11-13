// config.js - every threshold and tunable number lives here.

export const CONFIG = {
  // Display
  FLASH_MS: 2000, // FLASH_MADE / FLASH_MISS duration before returning to LIVE

  // Distance buckets: index = clamp(floor((ft - BUCKET_MIN_FT) / BUCKET_SIZE_FT), 0, BUCKET_COUNT - 1)
  BUCKET_MIN_FT: 10,
  BUCKET_SIZE_FT: 5,
  BUCKET_COUNT: 6,
  DIST_MIN_FT: 10,
  DIST_MAX_FT: 40,

  // Player height (inches), saved between launches
  HEIGHT_DEFAULT_IN: 70,
  HEIGHT_MIN_IN: 40,
  HEIGHT_MAX_IN: 90,
  STORAGE: { height: 'dgp.heightIn' },

  // Screen background colours. Text colour is chosen by contrast ratio (display.js).
  COLORS: {
    NOT_READY: '#ff1a1a',
    LIVE: '#ffffff',
    FLASH_MADE: '#00d84a',
    FLASH_MISS: '#ffe100',
    POST_ROUND: '#1a5cff',
  },

  // Camera requests, best first. The Pixel 6 Pro front camera tops out at 30 fps
  // (capability max 30 in the Phase 1 test), so the 60 fps tries just fall through.
  CAMERA_REQUESTS: [
    { label: '1920x1080 @60', w: 1920, h: 1080, fps: 60 },
    { label: '1920x1080 @30', w: 1920, h: 1080, fps: 30 },
    { label: '1280x720 @60', w: 1280, h: 720, fps: 60 },
    { label: '1280x720 @30', w: 1280, h: 720, fps: 30 },
    { label: 'browser default', w: null, h: null, fps: null },
  ],
  FPS_WINDOW_MS: 3000,

  // Debug-only simulated throw values (?debug=1)
  SIM: {
    startDistanceFt: 15,
    stepFt: 5,
    speedMph: [18, 34],
    angleDeg: [8, 22],
    unmeasuredChance: 0.15, // chance speed/angle show "--"
    missDirections: ['short', 'long', 'left', 'right'],
  },
};
