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

  // ---- Phase 5b: disc tracking and make/miss (outcome.js) -------------------------------------
  // All first guesses, deliberately conservative: when in doubt the throw is IGNORED.
  // Units: u = distance along the putt line from the basket centre in cage widths (negative =
  // before the basket, positive = beyond it); v = vertical offset from the cage centre in cage
  // heights (positive = down). ft = feet at the throwing spot's scale.
  OUTCOME: {
    // Frame source (a background model and frame difference inside a corridor around the putt line)
    ANALYSIS_W: 960, // the video is scaled to this width for analysis (disc is ~15 px wide here)
    BG_ALPHA: 0.02, // background follows the scene at this rate per frame (a resting disc fades in ~2 s)
    FG_THRESH: 28, // brightness difference from the background that counts as foreground (0-255)
    MOVE_THRESH: 20, // brightness difference from the previous frame that counts as moving
    MIN_BLOB_PX: 8, // smaller blobs are noise (analysis pixels)
    MAX_BLOB_PX: 500, // bigger blobs are people, shadows, cloud edges
    MAX_BLOB_DIM_PX: 48,
    MAX_BLOBS: 10, // kept per frame (largest first)
    WARMUP_FRAMES: 20, // frames after (re)start before blobs are trusted
    NOISE_FG_FRAC: 0.02, // more foreground than this in the corridor = the picture is too busy to judge
    FRAME_BUF_MS: 7000,
    // Corridor (fractions of the frame): from the thrower to past the basket, around the cage
    ROI_UP_H: 3.0, // cage heights above the cage top
    ROI_DOWN_H: 3.5, // cage heights below the cage bottom (the ground at the pole)
    ROI_BEYOND_W: 3.0, // cage widths beyond the cage centre
    ROI_BEHIND: 0.03, // frame widths behind the thrower
    // Gates on the scene (a failure ignores every throw)
    BOX_FT: [1.0, 4.0], // cage width and height must be in this range at the thrower's scale
    ANCHOR_FT: [6, 50], // thrower to basket distance must be in this range
    // Flight tracking
    PRE_MS: 150, // frames this long before the release time are searched for the disc
    START_WINDOW_MS: 450, // the disc must first be seen within this long after the release
    START_RADIUS_FT: 5, // ...and within this distance of the hand
    PLAYER_PAD_FT: 1.0, // blobs this close to the body are the body, except right after release
    PLAYER_FREE_MS: 300,
    MIN_MOVE: 0.3, // share of a blob's pixels that also changed since the last frame, for flight
    GATE_FT: 1.0, // how far from the predicted position the next detection may be
    G_FTS2: 32.2,
    VX_MIN_FTS: 12, // forward speed range of a putt (ft/s)
    V_MAX_FTS: 90,
    MAX_GAP_MS: 110, // longest gap between two detections of one track
    MIN_TRACK_PTS: 4,
    DENSITY_MIN: 0.35, // share of frames along the flight in which the disc was seen: below MIN a make is
    DENSITY_FULL: 0.65, // impossible (the exit could have been missed too), at FULL this factor is 1
    MAX_TRACK_RMS_FT: 0.8, // x(t) line fit and y(t) parabola fit residual
    FLIGHT_WAIT_MS: 2600, // no track by this long after the release = ignored
    HORIZON_MS: 4500, // hard end of a throw's evaluation
    // Zones around the cage (u, v units, see above)
    CORE_U: 0.75, // inside this and CORE_V the disc counts as "in the cage"
    CORE_V: 0.75,
    ARRIVE_U: 0.9, // a detection this near the cage in u and
    ARRIVE_V: 0.8, // ...in v counts as arriving (above the cage top or below the tray does not)
    INFER_U: 1.6, // track ended this close in u may still be taken as arriving (with chain audio)
    PASS_U: 1.3, // detections this far beyond the cage mean the disc flew past
    REST_OUT_U: 1.0, // a resting disc outside this |u| or REST_OUT_V is out of the basket;
    REST_OUT_V: 1.0, // between the core and this it is ambiguous (blocks a make, scores nothing)
    EXIT_U: 1.1, // moving blobs outside this |u| or EXIT_V, after contact, count as leaving the cage
    EXIT_V: 1.2,
    EXIT_MAX_U: 3, // ...but only this far from the cage along the line, and
    EXIT_V_RANGE: [-1.5, 3.5], // ...within this range of v (a bounced disc stays near the pole)
    EXIT_GRACE_MS: 80, // ...starting this long after contact
    EXIT_WEAK_FRAMES: 2, // this many frames with stray moving blobs there block a make
    EXIT_BASE_MAX: 0.25, // share of quiet frames before the throw with such blobs: above this the scene is too busy
    TRACK_LOST_MS: 1500, // track ended short of the cage and nothing new for this long = ignored
    // Resting-disc test (a disc that landed or dropped out)
    REST_FRAMES: 5, // frames a static blob must persist
    REST_MOVE_MAX: 0.2,
    REST_RADIUS_FT: 0.6,
    REST_NEAR_TRACK_FT: 8, // the resting blob must be this close to where the disc was last seen
    // Contact and settling
    AUDIO_MATCH_MS: [-250, 450], // chain burst start relative to the arrival time
    SETTLE_MS: 1000, // wait this long after contact before calling a make
    AUDIO_LATE_MS: 700, // extra wait for a late audio event
    EXIT_MIN_PTS: 3, // an exit track (disc leaving the cage) needs this many detections
    MIN_FPS: 15, // frames per second in the settle window needed to trust "nothing left"
    MAX_GAP_SETTLE_MS: 150,
    // Confidence needed to show a verdict (each is the weakest of several 0-1 factors)
    CONF_MIN_MAKE: 0.7,
    CONF_MIN_MISS: 0.6,
    ALLOW_INFERRED_ARRIVAL: true,
    // Late verdicts at round end
    ROUND_END_HOLD_MAX_MS: 4000, // longest a round end waits for a throw still being judged
    POST_FLASH_HOLD_MS: 1000, // after a make/miss verdict the round end waits this long so it can be seen
    LOG_N: 12, // verdicts kept for the debug read-out
    REPLAY_N: 6, // throws whose full frame data is kept for the debug "Save replay" file
    SNAPSHOT_W: 960, // width of the JPEG grabbed at each release for that file (0 = off)
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
