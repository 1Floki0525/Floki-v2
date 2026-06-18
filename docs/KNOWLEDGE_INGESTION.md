# Knowledge Ingestion

Stage 12.33 adds chat-mode knowledge ingestion for local text and transcript files.

This stage does not call Qwen, Broca, Piper, microphone, speaker, network tools, YouTube, yt-dlp, or Minecraft. It only reads already-local text files and writes deterministic chunks into local project state.

## Correct media root

The Floki media corpus root is outside the Floki-v2 git repo:

/media/binary-god/2tb-ssd/Floki-media

YouTube transcript text folders should be shaped like:

/media/binary-god/2tb-ssd/Floki-media/text/youtube/<channel-folder>/

Do not store media or transcripts under:

/media/binary-god/1tb-ssd/Floki-v2/floki-media

## Guard

Knowledge ingestion is blocked unless explicitly enabled:

FLOKI_ALLOW_KNOWLEDGE_INGESTION=1

When guarded, the module does not read source files, write chunks, write indexes, call models, call the network, or start game mode.

## Supported in this stage

- .txt
- .md
- .json
- .jsonl
- .srt
- .vtt
- .log
- .csv
- directories of those files
- YouTube transcript channel folders containing transcripts.manifest.jsonl and/or SCRAPE_REPORT.latest.json

Unsupported file types are counted honestly and skipped.

## Not supported yet

- PDF
- DOCX
- EPUB
- MP3
- WAV
- MP4
- AVI
- MKV
- MOV
- WEBM

Those belong in later extractor and media transcription stages.

## Persistence

Runtime knowledge state is written under project state and must not be committed:

state/floki/chat/knowledge/chunks.jsonl
state/floki/chat/knowledge/sources.jsonl
state/floki/chat/knowledge/index.json
state/floki/chat/knowledge/ingestion-events.jsonl

Reports are written under:

.floki-tools/output/knowledge-ingestion/latest-knowledge-ingestion.json

## Proofs

npm run proof:knowledge-ingestion-guard
npm run proof:knowledge-ingestion
