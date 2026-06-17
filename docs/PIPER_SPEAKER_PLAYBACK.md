# Floki-v2 Piper Speaker Playback

Batch 12.2 adds guarded speaker playback.

Normal npm test only runs the guard proof. It does not play audio.

Manual playback proof:

npm run proof:piper-speaker-playback

That script sets:

FLOKI_ALLOW_SPEAKER_PLAYBACK=1

Expected guard marker:

FLOKI_V2_PIPER_SPEAKER_PLAYBACK_GUARD_PASS

Expected manual playback marker:

FLOKI_V2_PIPER_SPEAKER_PLAYBACK_PASS
