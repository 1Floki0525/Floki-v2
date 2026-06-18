# Dream Acceptance

Stage 12.32 proves the dream module end-to-end without starting game mode.

Acceptance covers:

- Dream Engine guard
- Sleep Cycle guard
- REM schedule for the 11 PM to 7 AM sleep window
- dream TXT creation
- dream metadata JSON creation
- dream index append
- dream memory consolidation
- dream recall retrieval
- wake interruption
- 120-second idle resume
- sleep cycle continuation instead of restart
- first-person dream voice
- no model JSON fallback
- schema-constrained dream JSON
- chat mode only
- game mode false

The contract proof uses an injected dream generator for deterministic tests. Live Dream Engine proof remains separate and must use the real model path when `FLOKI_ALLOW_DREAM_ENGINE=1` is run directly.
