# Webcam Live Vision Acceptance

Stage 12.38 hardens the guarded chat-mode webcam proof without weakening the
40 FPS contract.

## Contract

- Chat mode webcam eyes remain YAML-driven and env-guarded.
- Game mode still uses `minecraft_first_person`; the USB webcam is not game
  eyes.
- Pineal mind-eye content remains private/internal and cannot enter public
  transcript or speech.
- Public transcript and speech reject private reasoning markers.
- Live webcam proof must measure actual frame throughput. Capability metadata
  can inform the report, but it must not produce a fake pass.

## Current Live Proof

Command:

```sh
FLOKI_ALLOW_WEBCAM_CAPTURE=1 FLOKI_ALLOW_CHAT_VISION=1 npm run proof:webcam-eyes-live-40fps
```

Result on 2026-06-18:

- Marker: `FLOKI_V2_WEBCAM_EYES_LIVE_40FPS_FAIL`
- Failure: `camera_low_light_dynamic_framerate_below_yaml_min_measured_fps`
- Device: `/dev/video0`
- Requested mode: `1280x720`, `mjpeg`, `40 FPS`
- Selected live attempt: YAML configured target mode, `1280x720`, `mjpeg`, `40 FPS`
- Measured FPS: `15.140793855644246`
- Frames measured: `115`
- Required minimum FPS: `40`
- V4L2 nominal FPS: `30`
- `auto_exposure`: `3` (`Aperture Priority Mode`)
- `exposure_dynamic_framerate`: `1`
- `exposure_time_absolute`: `664`
- Exposure-derived FPS estimate: `15.060240963855422`
- `ffmpeg_exit_status`: `0`
- `live_capture_run_now`: `true`
- `webcam_opened_now`: `true`
- `frame_capture_run_now`: `true`
- `desktop_screenshot_run_now`: `false`
- `public_transcript_visible`: `false`
- `fake_pass`: `false`

This is an honest measured failure, not a green acceptance. The camera path did
open and measure live frames, but current camera controls dynamically limited
the stream below the YAML `min_measured_fps`.
