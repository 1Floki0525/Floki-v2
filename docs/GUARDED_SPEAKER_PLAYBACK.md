# Floki-v2 Guarded Speaker Playback

Batch 12.17 allows real speaker playback only while the voice-output lock is active.

## Source rule

Speaker playback must be wrapped by the voice-output lock.

Required sequence:

1. Piper WAV already exists.
2. Begin voice-output lock.
3. Ears are muted.
4. Run speaker playback.
5. Clear voice-output lock in a finally-style path.
6. Ears are open after playback.

## No shortcuts

The contract does not fake live speaker success.

The contract proves the lock semantics with injected playback runners so npm test does not play sound.

The live proof still uses real aplay through:

npm run proof:piper-speaker-playback

## Required live proof fields

- voice_output_lock_started: true
- ears_muted_during_playback: true
- voice_output_lock_cleared_after_playback: true
- ears_open_after_playback: true
- piper_speech_run_now: true
- speaker_playback_run_now: true

## Contract marker

FLOKI_V2_SPEAKER_PLAYBACK_VOICE_LOCK_CONTRACT_PASS
