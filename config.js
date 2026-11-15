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

  // ---- Phase 3: basket, pose and round tracking -----------------------------

  // Basket x as a fraction of the RAW camera frame width (0 = left edge of the unmirrored
  // frame, 1 = right edge). null = find it automatically (outcome.js, BASKET below) and show
  // FINDING BASKET until it is found. A number here skips the search and forces that x.
  // In ?debug=1, "Set basket (tap)" in the debug panel still overrides either one.
  BASKET_X_NORM: null,

  // MediaPipe Pose Landmarker (pinned version, loaded from a CDN).
  POSE: {
    BUNDLE_URL: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    WASM_URL: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
    MODEL_URL:
      'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
    MIN_DETECT_CONF: 0.5,
    MIN_PRESENCE_CONF: 0.5,
    // The model's person detector sees a ~224 px square, so a whole 1080p frame makes a
    // 5-6 ft player only ~25 px tall. We feed it square crops instead (see pose.js).
    CROP_PX: 384, // crop is drawn to a CROP_PX x CROP_PX canvas before inference
    TILE_FRAC: 0.6, // search tile side as a fraction of frame height
    TILE_STEP_FRAC: 0.7, // horizontal tile step as a fraction of tile side
    SEARCH_ROW_CENTERS: [0.5, 0.38, 0.62], // tile row centres as a fraction of frame height
    TRACK_PAD: 2.6, // tracking crop side = person bbox height x this
    TRACK_MIN_SIDE_FRAC: 0.3, // tracking crop never smaller than this fraction of frame height
    TRACK_FAIL_FRAMES: 6, // misses in a row before falling back to the tile search
    MIN_BBOX_FRAC: 0.05, // reject detections shorter than this fraction of frame height
  },

  // round.js: player state, anchor spot, scale, round start/end.
  TRACK: {
    VIS_MIN: 0.5, // landmark visibility counted as "seen"
    MIN_MEAN_VIS: 0.2, // below this mean visibility the detection is treated as no player
    EDGE_MARGIN: 0.01, // a landmark this close to the frame edge counts as cut off

    // Upright test (all must pass). Standing: tilt ~0-8 deg, torso ratio ~0.55-0.65, head ratio ~0.35.
    UPRIGHT_MAX_TILT_DEG: 20, // shoulder-mid to hip-mid vs vertical
    UPRIGHT_TORSO_RATIO: [0.45, 0.85], // (shoulder->hip height) / (hip->ankle height); low = bent over, high = squatting
    UPRIGHT_MIN_HEAD_RATIO: 0.2, // (nose above shoulders) / torso height; low = head dropped

    // Height scale: nose-to-floor is this fraction of standing height (tune if distances read long/short).
    NOSE_HEIGHT_FRAC: 0.925,

    // Still test: feet and hips move less than this fraction of body height over the window.
    STILL_WINDOW_MS: 500,
    STILL_MIN_SAMPLES: 4,
    STILL_MAX_MOVE_FRAC: 0.035,
    READY_HOLD_MS: 1000, // still + upright this long before READY (first round)
    RETURN_HOLD_MS: 2000, // same, after a round, before the next round starts
    RETURN_MIN_FT: 8, // after a round the player must be at least this far from the basket to start again

    // Presence with grace so a flickering pose never flashes the screen red.
    PRESENT_FRAMES: 3, // consecutive good frames to count as present
    LOST_MS: 1500, // missing this long before the player counts as gone
    VIEW_HOLD_MS: 500, // a camera read-out message must persist this long before it shows or clears

    // Round end: feet move toward the basket this far from the anchor spot, held briefly.
    ROUND_END_TOWARD_FT: 4,
    ROUND_END_HOLD_MS: 250,
    ROUND_END_MEDIAN_N: 5, // samples in the median that smooths foot x
  },

  // throws.js: release detection from wrist motion (Phase 4). Distances are in BODY HEIGHTS
  // (pixels divided by the player's pixel height), speeds in body heights per second, so
  // they do not depend on how far the player stands from the phone. These are first guesses:
  // tune them with the motion trace in ?debug=1.
  THROW: {
    VIS_MIN: 0.35, // wrist landmark visibility needed to use a sample
    BODY_VIS_MIN: 0.3, // shoulder / hip / nose visibility needed for the body gates
    VEL_WINDOW_MS: 120, // wrist speed is measured over about this long
    VEL_MIN_SPAN_MS: 50, // ...but never over less than this
    SPEED_START: 1.0, // forward wrist speed that opens a swing
    SPEED_END: 0.5, // below this the swing is over (the follow-through has begun)
    SPEED_MIN: 1.8, // peak forward speed a real putt must reach (a slow reach stays below)
    SWING_MIN_MS: 70, // swings shorter than this are pose jitter
    SWING_MAX_MS: 700, // swings longer than this are not a putt
    GAP_MS: 250, // wrist unseen this long aborts an open swing
    BACK_WINDOW_MS: 500, // look back this far for the backswing position
    EXT_GAIN_MIN: 0.12, // wrist must move this far forward of the shoulder during the swing
    EXT_MIN: 0.10, // ...and end at least this far forward of the shoulder
    FWD_SHARE_MIN: 0.6, // forward part of the wrist path (1 = level, 0 = straight down or up)

    // Gates read at the moment of peak speed. Any failure rejects the swing.
    MAX_TILT_DEG: 45, // shoulder-mid to hip-mid tilt; real putts read 25-37, bends to the bag 53-90
    MIN_HEAD_RATIO: 0.12, // (nose above shoulders) / torso height; a dropped head means bending
    MIN_WRIST_RISE: -0.15, // wrist height above the hips, in torso heights; the bag is below it
    HIP_WINDOW_MS: 600,
    HIP_MAX_MOVE: 0.75, // hip travel (body heights) in the window; real putts read 0.1-0.5, bends 1.0-2.9
    ANCHOR_MAX_FT: 3, // feet must be this close to the throwing spot
    MIN_GAP_MS: 1500, // no second throw this soon after one

    BUF_MS: 1200, // wrist sample history kept
    TRACE_MS: 8000, // debug motion trace length
    TRACE_MAX_SPEED: 4, // top of the debug trace (body heights per second)
    LOG_N: 5, // recent swing verdicts shown in the debug read-out
  },

  // ---- Phase 5a: outcome.js - basket finder and chain-sound detector ---------------------
  // All first guesses: tune them against real footage (?debug=1 can record clips).

  // Basket finder: finds a square patch of dense vertical lines (the chain cage) near either end
  // of the putt line. Coordinates are fractions of the raw frame.
  BASKET: {
    SCAN_MS: 250, // time between scans while searching (nothing runs once the basket is found)
    SCAN_W: 960, // analysis width in px; the chains are too fine to see much below this
    SEARCH_X: [[0.02, 0.40], [0.60, 0.98]], // the basket is at one end of the line, so near a side
    SEARCH_Y: [0.30, 0.75], // box centre must lie in this band of the frame height
    BOX_H_FRACS: [0.05, 0.065, 0.08, 0.10], // cage height as a fraction of frame height (scales tried)
    BOX_ASPECT: 1.0, // cage width / height
    BOX_STEP_PX: 2, // search step in analysis pixels
    EDGE_MIN: 18, // horizontal brightness step (0-255) that counts as an edge
    VERT_RATIO: 2.0, // ...and it must beat the vertical step by this factor (so it is a vertical line)
    MIN_DENSITY: 0.25, // fraction of box pixels that must be vertical edge
    SURROUND_W: 1.0, // weight of the dense-on-both-sides penalty (fences, tree lines)
    MIN_SCORE: 0.20, // density minus the denser neighbour, below this the scan finds nothing
    HISTORY: 12, // scans remembered (12 scans = 3 s)
    STABLE_FRAC: 0.8, // this share of them must agree on one x before it is accepted
    STABLE_TOL: 0.012, // ...within this x distance (fraction of frame width)
    EXCLUDE_PAD: 0.03, // margin added around the player's x span (the player is never the basket)
    EXCLUDE_TTL_MS: 1000, // a player span older than this is ignored
  },

  // Chain-rattle detector (Web Audio). Levels are dB relative to full scale, per FFT bin.
  CHAIN: {
    FFT_SIZE: 1024, // ~21 ms window, ~47 Hz bins at 48 kHz
    POLL_MS: 15, // how often the spectrum is read
    LOW_HZ: [80, 800], // thump band (footsteps, wind rumble)
    HF_EDGES_HZ: [2000, 3500, 5500, 8000, 12000], // the chain band, as four sub-bands
    WARMUP_MS: 1500, // no events until the noise floor has settled
    MIN_FLOOR_DB: -95, // floors never go below this, so digital silence cannot fake huge rises
    FLOOR_TAU_UP_MS: 4000, // noise floor follows rising sound this slowly (absorbs steady wind)
    FLOOR_TAU_UP_FAST_MS: 1200, // ...and this fast after a too-long burst
    FLOOR_TAU_DOWN_MS: 400, // ...and falling sound this fast
    ONSET_DB: 12, // chain band must jump this far above its floor
    ATTACK_DB: 8, // ...and rise this much within ATTACK_MS (wind builds slower)
    ATTACK_MS: 100,
    BAND_RISE_DB: 8, // a sub-band counts as "hit" at this rise
    MIN_BANDS: 3, // sub-bands (of 4) that must be hit: the broadband test
    LOW_DOMINANCE_DB: 6, // reject if the low band rose this much more than the chain band (thump)
    END_DB: 6, // burst is over when the rise stays below this for HANG_MS
    HANG_MS: 80,
    MIN_DUR_MS: 50, // shorter than this is a click, not a rattle
    MAX_DUR_MS: 900, // longer than this is wind or speech: ignored
    MIN_PEAK_DB: -85, // absolute level the burst must reach (per-bin dBFS in the chain band)
    DEAD_DB: -130, // chain band quieter than this for DEAD_MS means a muted mic: NO AUDIO
    DEAD_MS: 3000,
  },

  // ?debug=1 clip recorder
  DEBUG_REC: {
    MAX_MS: 30000, // a clip stops by itself at this length
    VIDEO_BPS: 6000000,
    AUDIO_BPS: 128000,
  },

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
