# Putting Practice Tracker

A hands-free disc golf putting tracker that runs as a static web app on a Pixel 6 Pro (Chrome). A stationary phone watches the putt line with its front camera and reports make % by distance, plus release speed and release angle per putt. The only time you touch the phone is to stop a session.

**Current status: Phase 1 (camera test page).** This page only proves what the front camera can do in the browser. There is no pose tracking, putt detection or scoring yet.

## What Phase 1 tests

- Front camera, requesting 1920x1080 at 60 fps with fallbacks (1080p30, 720p60, 720p30, browser default)
- Delivered resolution, the frame rate the browser reports, and measured frame rate (rolling 3 s average using `requestVideoFrameCallback`)
- Screen Wake Lock (shows active, released or failed)
- Mirrored live feed
- Microphone access, with echo cancellation, noise suppression and auto-gain off, and a live level bar (RMS plus peak hold in dBFS)

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `styles.css` | Minimal landscape-first layout |
| `camera.js` | Camera, fps measurement, wake lock and audio meter |

## Hosting

The camera API needs HTTPS. The easiest option is GitHub Pages:

1. Put the three files in the root of a repository.
2. In the repository settings, enable Pages and serve from the main branch.
3. Open the published `https://` URL on the phone.

For local testing on a computer, `http://localhost` also works. There is no build step and no dependencies.

## Running the test

1. Open the page on the Pixel 6 Pro in Chrome and rotate to landscape.
2. Tap **Start** and allow camera and microphone access.
3. Read the results: delivered resolution, reported fps, measured fps, wake lock status and mic status.
4. Tap **Stop** to release the camera, mic and wake lock.

## What to look for

- Delivered resolution of 1920 x 1080 and measured fps near 60. If you only get about 30 fps, the throw-tracking plan needs to change.
- Wake lock stays active with the phone untouched for a couple of minutes.
- The audio level responds to a clap, and the RMS level does not drift on its own. Drift would mean auto-gain is still on.
- The log at the bottom shows which constraint attempt succeeded and the mic settings the browser actually applied.

## Planned structure (later phases)

`config.js`, `pose.js`, `state.js`, `display.js`, `setup.js`, `round.js`, `throws.js`, `outcome.js`, `flight.js`, `stats.js`, `export.js` and `main.js`. Pose tracking will use MediaPipe Pose Landmarker (Tasks Vision) from a CDN with a pinned version. All thresholds will live in `config.js`, and a `?debug=1` mode will show landmarks, fps and state.

## Known limits

- A web page cannot set screen brightness, so the app does not try.
- The disc is only about 30 px wide at 1080p, so disc tracking will be hard and some throws will be ignored rather than guessed.
- Chrome cannot force landscape without fullscreen, so rotate the phone yourself.
