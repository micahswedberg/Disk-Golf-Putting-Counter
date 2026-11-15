# Putting Practice Tracker

A hands-free disc golf putting tracker that runs as a static web app on a Pixel 6 Pro (Chrome). A stationary phone watches the putt line with its front camera and microphone and is meant to report make % by distance, plus release speed and release angle per putt. The only time you touch the phone is to stop a session.

There is no build step, no backend, no accounts and no uploads. Everything runs on the device.

## Status

Built in phases. The app launches and runs a real session, but it cannot yet tell a make from a miss.

| Area | State |
| --- | --- |
| Camera, wake lock, microphone | Done |
| Startup screen and height entry | Done |
| Screen states and state machine | Done |
| Pose tracking, player presence, round start/end, distance | Done |
| Throw detection (from wrist motion) | Done, thresholds are first guesses |
| Basket location (automatic) | Phase 5a, untested on real footage |
| Chain-rattle sound detection | Phase 5a, untested on real footage |
| Disc tracking, make/miss | Not started |
| Release speed and angle | Not started |
| Stats and CSV export | Not started |

**Temporary outcome:** until make/miss exists, every detected throw is scored as a MISS. In `?debug=1` the **Outcome** button cycles MISS / MAKE / ALT so you can see the other screens.

## How it works

1. **Setup.** Top-down and side-view diagrams show where to put the phone. Enter your height (it is remembered) and tap Start.
2. **Not ready.** A full-screen red warning gives one reason: `NO CAMERA`, `NO AUDIO`, `FINDING BASKET`, `STEP INTO FRAME`, `STAND STILL` or `TRACKING LOST`.
3. **Live.** The current round (made / thrown) fills the screen, with a make % strip by 5 ft distance bucket and a small mirrored camera feed.
4. **Flash.** A green "Chains!" or yellow "MISS" screen shows the distance (and speed and angle when measured), then returns to Live.
5. **Post round.** A blue screen shows the round summary the whole time you are picking up discs. It ends when you return to the throwing spot and stand still.

A round ends when you leave the throwing spot toward the basket. Bending to your bag or shifting your feet does not end it. A throw made while Not ready is not recorded.

## Physical setup

- Putt line up to 40 ft, basket at one end, throwing distances 10 to 40 ft.
- Phone in landscape, perpendicular to the midpoint of the line, about 25 to 30 ft back, chest height, level, with the whole line and the basket in frame.
- Distance comes from your horizontal foot position relative to the basket, scaled by the height you entered.
- The basket is searched for near the left and right ends of the frame, so keep it out of the middle.

## Hosting

The camera API needs HTTPS. The easiest option is GitHub Pages:

1. Put the files in the root of a repository.
2. In the repository settings, enable Pages and serve from the main branch.
3. Open the published `https://` URL on the phone and rotate to landscape.

For local testing on a computer, `http://localhost` also works. Pose tracking loads MediaPipe Tasks Vision (pinned version) from the jsDelivr CDN and the pose model from Google storage, so the first launch needs a network connection.

## Debug mode

Add `?debug=1` to the URL. Normal behaviour does not change. A tray appears at the bottom (at the top on the setup screen, so it never covers Start) with:

- **DBG** panel: simulated events (throws, round end, flag toggles), the tracking read-out, a wrist-speed trace for throw detection, and **Copy swing log**.
- **Set basket (tap)** and **Clear basket**: override or restart basket detection. **Big cam** enlarges the corner feed.
- **OUT** panel: the basket finder's view (search area, best box, locked basket), a live chain-sound trace (chain band and low band rise over the noise floor), recent chain events, and **Record clip**.
- **Record clip** saves a video with audio (up to 30 s) to the phone, so detection can be tuned against real footage.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Page structure and styling |
| `config.js` | Every threshold and tunable number |
| `camera.js` | Front camera, delivered resolution and fps, microphone, wake lock |
| `pose.js` | MediaPipe Pose Landmarker wrapper, searches and tracks with square crops |
| `state.js` | The state machine (pure logic, no DOM) |
| `display.js` | Renders each screen state, contrast helper, flashes, corner feed |
| `setup.js` | Startup diagram screen and height entry |
| `round.js` | Player presence, still and upright tests, anchor spot, distance scale, round end |
| `throws.js` | Throw detection from wrist motion |
| `outcome.js` | Basket finder and chain-sound detector |
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
- The basket finder looks for a patch of dense vertical lines (the chain cage). It has only been tested on synthetic images, and trees, fences or a busy background could fool it. Use `?debug=1` to check what it locked onto.
- The chain detector flags short, bright, broadband bursts. Footsteps and wind are rejected by design, but speech and claps can still trigger it, and a faint rattle 30 ft away may be missed. Make/miss will only accept a sound that follows a visual disc contact.
- Distances are expected to be within about 1 to 2 ft.

## Out of scope for v1

Multiple phones or 3D, form or pose coaching, slow-motion video import, accounts, sync, uploads, and any editing or corrections after a session.
