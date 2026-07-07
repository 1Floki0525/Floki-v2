# Vision readiness repair

Repair webcam/YOLO/vision readiness and suspend/restore around GPU training.

## When to use
Vision is not ready, or training resource mode must stop vision to free the GPU.

## Rules
- During training/nighttime sleep, vision (YOLO/Grounding DINO) and the camera are off and must be restored on wake.
- Surface any restoration failure; do not silently swallow it.
