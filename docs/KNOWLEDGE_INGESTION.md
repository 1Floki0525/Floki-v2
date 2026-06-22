# Knowledge Ingestion

Floki-v2 can use public YouTube subtitle transcripts as raw local knowledge material. The transcript scraper downloads subtitle data only, converts it into clean text, and leaves video and audio media untouched.

## Public transcript boundaries

`bin/scrape-youtube-public-transcripts.sh` is restricted to public, non-live content. Members-only, subscriber-only, private, restricted, unavailable, removed, age-gated, and live videos are skipped. The command uses `--skip-download`; it does not download video or audio.

## Local configuration

The public repository tracks these templates:

```text
config/chat.config.yaml.temp
config/game.config.yaml.temp
```

Personal working configuration is intentionally not tracked. Create it from the template:

```bash
cp config/chat.config.yaml.temp config/chat.config.yaml
cp config/game.config.yaml.temp config/game.config.yaml
```

Set `paths.youtube_cookies_file` in your local `config/chat.config.yaml` to your own absolute cookie-file path outside the repository. The scraper reads that value through Floki's normal typed configuration API. It has no repository-local cookie fallback.

## Browser cookies

YouTube may require browser cookies even when the requested subtitles belong to public videos. Export cookies in Netscape `cookies.txt` format and store the file outside the Floki-v2 repository.

Protect it:

```bash
chmod 600 /absolute/path/outside/the/repository/cookies.txt
```

Never commit the file, attach it to a bug report, include it in a project snapshot, copy it into a transcript folder, or place it under runtime state. Browser cookies are authentication secrets. Rotate or revoke them immediately if they are accidentally committed or shared. Cookies expire and may need to be exported again.

## Project-local yt-dlp environment

Create the project-local environment:

```bash
python3 -m venv .floki-tools/yt-dlp-venv
.floki-tools/yt-dlp-venv/bin/python -m pip install --upgrade pip
.floki-tools/yt-dlp-venv/bin/python -m pip install --upgrade "yt-dlp[default]"
```

Update an existing environment:

```bash
.floki-tools/yt-dlp-venv/bin/python -m pip install --upgrade "yt-dlp[default]"
```

The virtual environment is local tooling and is ignored by Git.

## Run the scraper

```bash
bin/scrape-youtube-public-transcripts.sh <youtube-channel-url> [channel-folder]
```

Example:

```bash
FLOKI_YT_MAX_VIDEOS=5 bin/scrape-youtube-public-transcripts.sh "https://www.youtube.com/@example/videos" example
```

The script validates that the YAML-configured cookie path is absolute and that the file exists and is readable. It passes the external file directly to `yt-dlp` and never copies or prints cookie contents.

## Output layout

The output roots come from the local chat YAML configuration:

- Cleaned transcripts: `paths.youtube_transcript_root/<channel-folder>/*.txt`
- Per-video metadata: `paths.youtube_transcript_root/<channel-folder>/*.meta.json`
- Channel manifest: `paths.youtube_transcript_root/<channel-folder>/transcripts.manifest.jsonl`
- Latest scrape report: `paths.youtube_transcript_root/<channel-folder>/SCRAPE_REPORT.latest.json`
- Raw subtitle files: `paths.media_root/raw/youtube/<channel-folder>/<timestamp>/`
- Scrape logs and discovered URL lists: `paths.media_root/logs/youtube/<channel-folder>/<timestamp>/`

No cookie file is written to any of those locations.

## Local knowledge ingestion

Already-downloaded transcript folders can be ingested into Floki's local knowledge state through the existing guarded knowledge-ingestion workflow. Runtime knowledge state remains under `state/` and must not be committed.
