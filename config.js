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
  // frame, 1 = right edge). null = not set, so the screen says FINDING BASKET.
  // Until basket detection exists (Phase 4+): set a number here, or in ?debug=1 use
  // "Set basket (tap)" in the debug panel and tap the enlarged camera feed.
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
