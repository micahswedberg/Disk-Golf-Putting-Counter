# Putting Practice Tracker

A hands-free disc golf putting tracker that runs as a static web app on a Pixel 6 Pro (Chrome). A stationary phone watches the putt line with its front camera and microphone and is meant to report make % by distance, plus release speed and release angle per putt. The only time you touch the phone is to stop a session.

There is no build step, no backend, no accounts and no uploads. Everything runs on the device.

## Status

Built in phases. The app launches and runs a real session. Make/miss from the disc tracker is written and passes synthetic tests, but it has not yet been tuned on real putts.

| Area | State |
| --- | --- |
| Camera, wake lock, microphone | Done |
| Startup screen and height entry | Done |
| Screen states and state machine | Done |
| Pose tracking, player presence, round start/end, distance | Done |
| Throw detection (from wrist motion) | Done, thresholds are first guesses |
| Basket marking (tap, then refined to the cage box) | Phase 5b, refine tested on one real frame |
| Basket location (automatic search) | Phase 5a, off by default (`BASKET.AUTO_FIND`) |
| Chain-rattle sound detection | Phase 5a, field-tested, registers hits well |
| Disc tracking, make/miss | Phase 5b, tested on synthetic putts only, thresholds are first guesses |
| Release speed and angle | Not started |
| Stats and CSV export | Not started |

**Outcome.** By default (AUTO) the result comes from the disc tracker and the chain sound, about 1 to 2.5 s after the release. A throw it is not sure about is ignored: no flash, and it only shows as "N ignored" on the blue round summary. In `?debug=1` the **Outcome** button can instead force MISS / MAKE / ALT so you can see the other screens.

## How it works

1. **Setup.** Top-down and side-view diagrams show where to put the phone. Enter your height (it is remembered) and tap Start.
2. **Tap the basket.** The camera view fills the screen under the prompt `TAP THE BASKET`. Tap the middle of the basket. The app looks around the tap for the top band and the tray and draws the cage box: **green** means the edges were found, **orange dashed** means only your tap is used and the size is guessed. Press **OK**, tap again to re-mark, or press **Fix top / bottom** and tap the top band, then the tray. During play a tiny **Re-mark basket** button sits next to Stop on the red screens.
3. **Not ready.** A full-screen red warning gives one reason: `NO CAMERA`, `TAP THE BASKET`, `NO AUDIO`, `STEP INTO FRAME`, `STAND STILL` or `TRACKING LOST`.
4. **Live.** The current round (made / thrown) fills the screen, with a make % strip by 5 ft distance bucket and a small mirrored camera feed.
5. **Flash.** A green "Chains!" or yellow "MISS" screen shows the distance (and speed and angle when measured), then returns to Live.
6. **Post round.** A blue screen shows the round summary the whole time you are picking up discs. It ends when you return to the throwing spot and stand still.

A round ends when you leave the throwing spot toward the basket. Bending to your bag or shifting your feet does not end it. If the last putt of a round is still being judged when you walk away, the round end waits for it (up to 4 s). A throw made while Not ready is not recorded.

## How make / miss is decided

All of this is in `outcome.js`, with thresholds in `config.js` under `OUTCOME`. The cage box from the basket step (top band to tray) is the area the disc must enter and stay in.

1. **Disc tracking.** A background model plus a frame difference, inside a corridor from the thrower to past the basket, gives small moving blobs. This runs in a worker (`disc-worker.js`) at the camera's frame rate, because pose tracking keeps the main thread busy. A ballistic fit through the blobs makes the flight track. The release time is only a rough guide (the wrist's peak speed can come about 0.5 s before a slow putt leaves the hand).
2. **Miss evidence.** The disc flies on past the cage (long); a new still blob (a landed disc) appears outside the cage, including on the ground at the pole (short or long); or a moving track leaves the cage after contact (bounce-out or drop-out).
3. **Make evidence.** The disc arrives in the cage (followed, or just a moving blob entering it), then a 1 s settle window passes with healthy video, nothing leaving and nothing resting outside. A new still blob that stays in the cage (a disc in the tray) or a chain sound at contact raises confidence. With neither, a make is still called at low confidence (`SILENT_CONF`; set `CONF_MIN_MAKE` above it to turn that off).
4. **Otherwise the throw is ignored.** A chain sound alone never scores. Each verdict carries a confidence made of several 0 to 1 factors (the weakest one counts). Thresholds are loosened for tuning, so expect some wrong calls: send the replay file after each session.
5. **Left / right misses** are not reported: a side-on camera cannot see depth, so only short and long are given.
6. **Gates.** If the cage box is implausible for the scale (for example a tree) or the basket distance is out of range, every throw is ignored.

## Physical setup

- Putt line up to 40 ft, basket at one end, throwing distances 10 to 40 ft.
- Phone in landscape, perpendicular to the midpoint of the line, about 25 to 30 ft back, chest height, level, with the whole line and the basket in frame.
- Distance comes from your horizontal foot position relative to the basket, scaled by the height you entered.
- Tap the basket at startup with the phone already in its final position. If you move the phone, re-mark the basket.

## Hosting

The camera API needs HTTPS. The easiest option is GitHub Pages:

1. Put the files in the root of a repository.
2. In the repository settings, enable Pages and serve from the main branch.
3. Open the published `https://` URL on the phone and rotate to landscape.

For local testing on a computer, `http://localhost` also works. Pose tracking loads MediaPipe Tasks Vision (pinned version) from the jsDelivr CDN and the pose model from Google storage, so the first launch needs a network connection.

## Debug mode

Add `?debug=1` to the URL. Normal behaviour does not change. A tray appears at the bottom (at the top on the setup screen, so it never covers Start) with:

- **DBG** panel: simulated events (throws, round end, flag toggles), the tracking read-out, a wrist-speed trace for throw detection, and **Copy swing log**.
- **Set basket (tap)** and **Clear basket**: both run the basket step again. **Big cam** enlarges the corner feed.
- **OUT** panel: the basket finder's view, a live chain-sound trace, recent chain events, the disc tracker (corridor, blobs, track overlay, per-throw verdicts with their confidence factors), and the buttons below.
- **Copy verdict log** copies one JSON line per recent throw with the result, reason, confidence and evidence.
- **Save replay** downloads a JSON file with everything the judge saw for the last 6 throws (blobs per frame, chain events, scene, and a JPEG of the frame at each release). The judge is a pure function, so this lets thresholds be tuned offline without video.
- **Record clip** saves a video with audio (up to 30 s) to the phone.

The tray hides itself during the basket step so it never covers the OK button.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Page structure and styling |
| `config.js` | Every threshold and tunable number |
| `camera.js` | Front camera, delivered resolution and fps, microphone, wake lock |
| `pose.js` | MediaPipe Pose Landmarker wrapper, searches and tracks with square crops |
| `state.js` | The state machine (pure logic, no DOM) |
| `display.js` | Renders each screen state, contrast helper, flashes, corner feed, the basket box overlay |
| `mark.js` | The "tap the basket" step: tap, confirm, fix by hand (no DOM) |
| `setup.js` | Startup diagram screen and height entry |
| `round.js` | Player presence, still and upright tests, anchor spot, distance scale, round end |
| `throws.js` | Throw detection from wrist motion |
| `outcome.js` | Basket finder and tap refinement, chain-sound detector, disc watcher, make/miss analysis, judge queue |
| `disc-worker.js` | Web worker: reads the camera frames and extracts disc blobs off the main thread |
| `main.js` | Wires everything together |
| `debug.js`, `outcome-debug.js` | `?debug=1` panels (loaded only in debug mode) |

Planned: `flight.js` (speed and release angle), `stats.js` and `export.js` (buckets, summaries, CSV).

## Data model

Throw record: `sessionId`, `timestamp`, `roundNumber`, `throwNumber`, `distanceFt`, `distanceBucket`, `result` (`make` or `miss`), `missDirection`, `speedMph`, `releaseAngleDeg`.

Bucket index = `clamp(floor((distanceFt - 10) / 5), 0, 5)`. A throw that cannot be called with confidence is ignored (counted in the round's ignored count, never recorded). A speed or angle that cannot be measured shows `--` and stays blank in the CSV.

## Known limits

- The Pixel 6 Pro front camera delivers at most 30 fps in Chrome, even though 60 fps is requested. The app reports the resolution and frame rate actually delivered.
- A web page cannot set screen brightness, so the app does not try.
- The disc is only about 30 px wide at 1080p, so disc tracking will be hard and some throws will be ignored rather than guessed.
- Chrome cannot force landscape without fullscreen. The app asks for fullscreen on Start, but rotate the phone yourself if it does not switch.
- The tap refinement looks for a top band and a tray (horizontal edges) and dense vertical lines (chains) near your tap. On one real frame, with a thin-chained basket in front of a fence, it found the cage within a few pixels for taps near the centre. Always check the box colour and outline before pressing OK. If it is orange, the size comes from your height and the scale.
- The make/miss logic has only been tested on synthetic putts. The thresholds are conservative first guesses, and a throw it cannot judge is ignored, so expect many ignored throws until it is tuned on real data. Pose tracking runs at about 12 fps and uses the main thread, so disc tracking runs in a worker. The OUT panel shows `(worker)` or `(main)` and the fps: if it says main, or fps is far below 25, the disc cannot be followed. Keep the tab in the foreground during a session (a hidden tab stops the camera frames).
- The chain detector flags short, bright, broadband bursts. Footsteps and wind are rejected by design, but speech and claps can still trigger it, and a faint rattle 30 ft away may be missed. Make/miss only accepts a sound that follows a visual disc contact.
- Distances are expected to be within about 1 to 2 ft.

## Out of scope for v1

Multiple phones or 3D, form or pose coaching, slow-motion video import, accounts, sync, uploads, and any editing or corrections after a session.
