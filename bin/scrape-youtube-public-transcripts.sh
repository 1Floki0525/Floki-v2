#!/usr/bin/env bash

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLOKI_MEDIA_ROOT="$(node -e "const c=require('./src/config/floki-config.cjs');console.log(c.getPathConfig('chat').media_root)" 2>/dev/null || echo '/media/binary-god/2tb-ssd/Floki-media')"
DEFAULT_COOKIES="$ROOT/docs/cookies.txt"

CHANNEL_URL="$1"
CHANNEL_FOLDER_ARG="$2"

COOKIES_FILE="${FLOKI_YT_COOKIES:-$DEFAULT_COOKIES}"
YTDLP_PY="${FLOKI_YTDLP_PY:-$ROOT/.floki-tools/yt-dlp-venv/bin/python}"

BASE_TEXT_DIR="${FLOKI_MEDIA_TEXT_YOUTUBE_DIR:-$FLOKI_MEDIA_ROOT/text/youtube}"
BASE_RAW_DIR="${FLOKI_MEDIA_RAW_YOUTUBE_DIR:-$FLOKI_MEDIA_ROOT/raw/youtube}"
BASE_LOG_DIR="${FLOKI_MEDIA_LOG_YOUTUBE_DIR:-$FLOKI_MEDIA_ROOT/logs/youtube}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

on_interrupt() {
  echo
  echo "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_INTERRUPTED"
  echo "Interrupted cleanly."
  exit 130
}

trap on_interrupt INT TERM

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

sanitize_name() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's#https?://##; s#youtube.com/##; s#www\.##; s#@##; s#/videos$##; s#/+$##; s#[^a-z0-9._-]+#_#g; s#^_+##; s#_+$##' \
    | cut -c1-120
}

is_members_only_error() {
  err_file="$1"

  grep -Eiq \
    'members-only|members only|available to this channel.s members|Join this channel|get access to members-only|channel.s members on level|exclusive perks|requires payment|subscriber-only|paid content|Pathfinder' \
    "$err_file"
}

is_private_or_unavailable_error() {
  err_file="$1"

  grep -Eiq \
    'private video|video is private|unavailable|not available|has been removed|copyright claim|blocked in your country|age-restricted|Sign in to confirm your age' \
    "$err_file"
}

clean_subtitle_to_text() {
  input_file="$1"
  output_file="$2"

  python3 - "$input_file" "$output_file" <<'PY'
import html
import re
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])

raw = src.read_text(encoding="utf-8", errors="replace")

timestamp_patterns = [
    re.compile(r"^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}:\d{2}[,.]\d{3}"),
    re.compile(r"^\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}[,.]\d{3}"),
    re.compile(r"^<\d{2}:\d{2}:\d{2}\.\d{3}>"),
]

tag_re = re.compile(r"<[^>]+>")
brace_re = re.compile(r"\{[^}]+\}")

lines = []
last = None

for line in raw.splitlines():
    line = line.strip("\ufeff").strip()

    if not line:
        continue

    upper = line.upper()

    if upper.startswith("WEBVTT"):
        continue
    if upper.startswith("KIND:") or upper.startswith("LANGUAGE:"):
        continue
    if upper.startswith("NOTE") or upper.startswith("STYLE"):
        continue
    if line.isdigit():
        continue
    if "-->" in line:
        continue
    if any(pattern.search(line) for pattern in timestamp_patterns):
        continue

    line = tag_re.sub("", line)
    line = brace_re.sub("", line)
    line = html.unescape(line)
    line = re.sub(r"\s+", " ", line).strip()

    if not line:
        continue

    if line == last:
        continue

    last = line
    lines.append(line)

text = "\n".join(lines).strip()
text = re.sub(r"\n{3,}", "\n\n", text)

dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(text + ("\n" if text else ""), encoding="utf-8")
PY
}

write_meta_json() {
  meta_file="$1"
  channel_url="$2"
  channel_folder="$3"
  video_url="$4"
  video_id="$5"
  title_guess="$6"
  source_subtitle_file="$7"
  text_file="$8"
  words="$9"
  chars="${10}"
  ytdlp_status="${11}"
  skip_kind="${12}"

  python3 - "$meta_file" "$channel_url" "$channel_folder" "$video_url" "$video_id" "$title_guess" "$source_subtitle_file" "$text_file" "$words" "$chars" "$ytdlp_status" "$skip_kind" <<'PY'
import json
import sys
from datetime import datetime, timezone

(
    meta_file,
    channel_url,
    channel_folder,
    video_url,
    video_id,
    title_guess,
    source_subtitle_file,
    text_file,
    words,
    chars,
    ytdlp_status,
    skip_kind,
) = sys.argv[1:]

data = {
    "channel_url": channel_url,
    "channel_folder": channel_folder,
    "video_url": video_url,
    "video_id": video_id,
    "title_guess": title_guess,
    "source_subtitle_file": source_subtitle_file,
    "text_file": text_file,
    "word_count": int(words),
    "char_count": int(chars),
    "yt_dlp_subtitle_status": int(ytdlp_status),
    "skip_kind": skip_kind,
    "downloaded_media": False,
    "created_at_utc": datetime.now(timezone.utc).isoformat()
}

with open(meta_file, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

append_manifest_jsonl() {
  manifest_file="$1"
  video_id="$2"
  title_guess="$3"
  video_url="$4"
  text_file="$5"
  words="$6"
  chars="$7"

  python3 - "$manifest_file" "$video_id" "$title_guess" "$video_url" "$text_file" "$words" "$chars" <<'PY'
import json
import sys
from datetime import datetime, timezone

manifest_file, video_id, title_guess, video_url, text_file, words, chars = sys.argv[1:]

record = {
    "video_id": video_id,
    "title_guess": title_guess,
    "video_url": video_url,
    "text_file": text_file,
    "word_count": int(words),
    "char_count": int(chars),
    "created_at_utc": datetime.now(timezone.utc).isoformat()
}

with open(manifest_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(record, ensure_ascii=False) + "\n")
PY
}

write_report_json() {
  report_file="$1"
  ok_value="$2"
  marker="$3"

  python3 - "$report_file" "$ok_value" "$marker" "$CHANNEL_URL" "$CHANNEL_FOLDER" "$TEXT_DIR" "$RAW_DIR" "$LOG_DIR" "$MANIFEST_FILE" "$VIDEO_COUNT" "$PROCESSED_COUNT" "$TRANSCRIPT_COUNT" "$SKIPPED_COUNT" "$SKIPPED_MEMBERS_COUNT" "$SKIPPED_UNAVAILABLE_COUNT" "$SKIPPED_NO_SUBTITLES_COUNT" "$FAILED_COUNT" "$YTDLP_VERSION" "$YTDLP_INVOKED" "$FLOKI_MEDIA_ROOT" <<'PY'
import json
import sys
from datetime import datetime, timezone

(
    report_file,
    ok_value,
    marker,
    channel_url,
    channel_folder,
    text_dir,
    raw_dir,
    log_dir,
    manifest_file,
    video_count,
    processed_count,
    transcript_count,
    skipped_count,
    skipped_members_count,
    skipped_unavailable_count,
    skipped_no_subtitles_count,
    failed_count,
    ytdlp_version,
    ytdlp_invocation,
    floki_media_root,
) = sys.argv[1:]

data = {
    "ok": ok_value == "true",
    "marker": marker,
    "channel_url": channel_url,
    "channel_folder": channel_folder,
    "floki_media_root": floki_media_root,
    "text_dir": text_dir,
    "raw_dir": raw_dir,
    "log_dir": log_dir,
    "manifest_file": manifest_file,
    "video_count_discovered": int(video_count),
    "video_count_processed_this_run": int(processed_count),
    "transcript_count_this_run": int(transcript_count),
    "skipped_count_this_run": int(skipped_count),
    "skipped_members_only_count_this_run": int(skipped_members_count),
    "skipped_private_unavailable_count_this_run": int(skipped_unavailable_count),
    "skipped_no_subtitles_count_this_run": int(skipped_no_subtitles_count),
    "failed_count_this_run": int(failed_count),
    "members_content_skipped": True,
    "downloaded_media": False,
    "yt_dlp_invocation": ytdlp_invocation,
    "yt_dlp_version": ytdlp_version,
    "created_at_utc": datetime.now(timezone.utc).isoformat()
}

with open(report_file, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

if [ -z "$CHANNEL_URL" ]; then
  echo "Usage:"
  echo "  bin/scrape-youtube-public-transcripts.sh <youtube-channel-url> [channel-folder]"
  echo
  echo "Example:"
  echo "  FLOKI_YT_MAX_VIDEOS=5 bin/scrape-youtube-public-transcripts.sh \"https://www.youtube.com/@morgueofficial/videos\" morgueofficial"
  exit 2
fi

have_cmd python3 || fail "python3 not found"
have_cmd find || fail "find not found"
have_cmd sort || fail "sort not found"
have_cmd sed || fail "sed not found"
have_cmd grep || fail "grep not found"
have_cmd wc || fail "wc not found"
have_cmd mkdir || fail "mkdir not found"

if [ ! -d "/media/binary-god/2tb-ssd" ]; then
  fail "2TB SSD mount is missing: /media/binary-god/2tb-ssd"
fi

mkdir -p "$FLOKI_MEDIA_ROOT" || fail "could not create media root: $FLOKI_MEDIA_ROOT"

if [ ! -x "$YTDLP_PY" ]; then
  fail "project-local yt-dlp venv missing. Run: python3 -m venv .floki-tools/yt-dlp-venv && .floki-tools/yt-dlp-venv/bin/python -m pip install -U --pre \"yt-dlp[default]\""
fi

YTDLP=("$YTDLP_PY" -m yt_dlp)
YTDLP_INVOKED="$YTDLP_PY -m yt_dlp"
YTDLP_VERSION="$("${YTDLP[@]}" --version 2>/dev/null | head -1)"

if [ -z "$YTDLP_VERSION" ]; then
  fail "could not get yt-dlp version from $YTDLP_PY"
fi

if [ ! -f "$COOKIES_FILE" ]; then
  fail "cookies.txt not found at: $COOKIES_FILE"
fi

if [ -n "$CHANNEL_FOLDER_ARG" ]; then
  CHANNEL_FOLDER="$(sanitize_name "$CHANNEL_FOLDER_ARG")"
else
  CHANNEL_FOLDER="$(sanitize_name "$CHANNEL_URL")"
fi

if [ -z "$CHANNEL_FOLDER" ]; then
  CHANNEL_FOLDER="unknown_channel"
fi

TEXT_DIR="$BASE_TEXT_DIR/$CHANNEL_FOLDER"
RAW_DIR="$BASE_RAW_DIR/$CHANNEL_FOLDER/$STAMP"
LOG_DIR="$BASE_LOG_DIR/$CHANNEL_FOLDER/$STAMP"

MANIFEST_FILE="$TEXT_DIR/transcripts.manifest.jsonl"
REPORT_FILE="$TEXT_DIR/SCRAPE_REPORT.latest.json"
COOKIE_WORK="$LOG_DIR/cookies.runtime.txt"
URL_LIST="$LOG_DIR/video-urls.txt"

mkdir -p "$TEXT_DIR" "$RAW_DIR" "$LOG_DIR" || fail "could not create output directories"

cp "$COOKIES_FILE" "$COOKIE_WORK" || fail "could not copy cookies file"
chmod 600 "$COOKIE_WORK" >/dev/null 2>&1

echo "FLOKI_YOUTUBE_TRANSCRIPT_SCRAPE_START"
echo "channel_url=$CHANNEL_URL"
echo "channel_folder=$CHANNEL_FOLDER"
echo "floki_media_root=$FLOKI_MEDIA_ROOT"
echo "text_dir=$TEXT_DIR"
echo "raw_dir=$RAW_DIR"
echo "log_dir=$LOG_DIR"
echo "cookies_source=$COOKIES_FILE"
echo "cookies_runtime_copy=$COOKIE_WORK"
echo "yt_dlp_invocation=$YTDLP_INVOKED"
echo "yt_dlp_version=$YTDLP_VERSION"
echo "sub_langs=${FLOKI_YT_SUB_LANGS:-en.*,en}"
echo

echo "Discovering channel videos..."
"${YTDLP[@]}" \
  --no-config \
  --cookies "$COOKIE_WORK" \
  --flat-playlist \
  --yes-playlist \
  --print "%(webpage_url)s" \
  "$CHANNEL_URL" > "$URL_LIST" 2> "$LOG_DIR/discovery.stderr.log"

DISCOVERY_STATUS="$?"

if [ "$DISCOVERY_STATUS" -ne 0 ]; then
  echo "Discovery failed. Last discovery errors:"
  tail -80 "$LOG_DIR/discovery.stderr.log"
  echo "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_FAIL"
  exit "$DISCOVERY_STATUS"
fi

grep '^http' "$URL_LIST" > "$URL_LIST.clean"
mv "$URL_LIST.clean" "$URL_LIST"

VIDEO_COUNT="$(wc -l < "$URL_LIST" | tr -d ' ')"

echo "video_urls_found=$VIDEO_COUNT"
echo

if [ "$VIDEO_COUNT" = "0" ]; then
  PROCESSED_COUNT=0
  TRANSCRIPT_COUNT=0
  SKIPPED_COUNT=0
  SKIPPED_MEMBERS_COUNT=0
  SKIPPED_UNAVAILABLE_COUNT=0
  SKIPPED_NO_SUBTITLES_COUNT=0
  FAILED_COUNT=0

  write_report_json "$REPORT_FILE" false "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_EMPTY"
  cat "$REPORT_FILE"
  exit 3
fi

if [ ! -f "$MANIFEST_FILE" ]; then
  : > "$MANIFEST_FILE"
fi

TRANSCRIPT_COUNT=0
SKIPPED_COUNT=0
SKIPPED_MEMBERS_COUNT=0
SKIPPED_UNAVAILABLE_COUNT=0
SKIPPED_NO_SUBTITLES_COUNT=0
FAILED_COUNT=0
VIDEO_INDEX=0
PROCESSED_COUNT=0

while IFS= read -r VIDEO_URL; do
  if [ -z "$VIDEO_URL" ]; then
    continue
  fi

  if [ -n "$FLOKI_YT_MAX_VIDEOS" ] && [ "$PROCESSED_COUNT" -ge "$FLOKI_YT_MAX_VIDEOS" ]; then
    echo "Reached FLOKI_YT_MAX_VIDEOS=$FLOKI_YT_MAX_VIDEOS"
    break
  fi

  VIDEO_INDEX=$((VIDEO_INDEX + 1))
  PROCESSED_COUNT=$((PROCESSED_COUNT + 1))

  VIDEO_ID="$(printf '%s' "$VIDEO_URL" | sed -nE 's#.*[?&]v=([^&]+).*#\1#p' | cut -c1-32)"

  if [ -z "$VIDEO_ID" ]; then
    VIDEO_ID="video_$VIDEO_INDEX"
  fi

  EXISTING="$(find "$TEXT_DIR" -maxdepth 1 -type f -name "*${VIDEO_ID}*.txt" | sort | head -1)"

  if [ -n "$EXISTING" ]; then
    echo
    echo "[$PROCESSED_COUNT/${FLOKI_YT_MAX_VIDEOS:-$VIDEO_COUNT}] already saved, skipping:"
    echo "  $VIDEO_URL"
    echo "  $EXISTING"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  echo
  echo "[$PROCESSED_COUNT/${FLOKI_YT_MAX_VIDEOS:-$VIDEO_COUNT}] Downloading transcript:"
  echo "$VIDEO_URL"

  VIDEO_RAW_DIR="$RAW_DIR/$VIDEO_ID"
  mkdir -p "$VIDEO_RAW_DIR"

  STDOUT_LOG="$LOG_DIR/subs_${PROCESSED_COUNT}_${VIDEO_ID}.stdout.log"
  STDERR_LOG="$LOG_DIR/subs_${PROCESSED_COUNT}_${VIDEO_ID}.stderr.log"

  "${YTDLP[@]}" \
    --no-config \
    --cookies "$COOKIE_WORK" \
    --no-progress \
    --no-abort-on-error \
    --skip-download \
    --write-subs \
    --write-auto-subs \
    --sub-langs "${FLOKI_YT_SUB_LANGS:-en.*,en}" \
    --sub-format "vtt/srt/best" \
    --match-filters "availability = 'public' & !is_live" \
    -P "home:$VIDEO_RAW_DIR" \
    -P "subtitle:$VIDEO_RAW_DIR" \
    -o "%(upload_date|00000000)s_%(id)s_%(title).120S.%(ext)s" \
    -o "subtitle:%(upload_date|00000000)s_%(id)s_%(title).120S.%(ext)s" \
    "$VIDEO_URL" > "$STDOUT_LOG" 2> "$STDERR_LOG"

  SUB_STATUS="$?"

  if is_members_only_error "$STDERR_LOG"; then
    echo "  members-only/subscriber-only content, skipped"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    SKIPPED_MEMBERS_COUNT=$((SKIPPED_MEMBERS_COUNT + 1))
    continue
  fi

  if is_private_or_unavailable_error "$STDERR_LOG"; then
    echo "  private/unavailable/restricted content, skipped"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    SKIPPED_UNAVAILABLE_COUNT=$((SKIPPED_UNAVAILABLE_COUNT + 1))
    continue
  fi

  SUB_FILE="$(find "$VIDEO_RAW_DIR" -type f \( -name '*.vtt' -o -name '*.srt' -o -name '*.ass' -o -name '*.ttml' -o -name '*.srv3' \) | grep -Ei '\.(en|en-US|en-GB|en-orig|en-auto|en\.)' | sort | head -1)"

  if [ -z "$SUB_FILE" ]; then
    SUB_FILE="$(find "$VIDEO_RAW_DIR" -type f \( -name '*.vtt' -o -name '*.srt' -o -name '*.ass' -o -name '*.ttml' -o -name '*.srv3' \) | sort | head -1)"
  fi

  if [ -z "$SUB_FILE" ]; then
    echo "  no transcript/subtitle file found"
    echo "  yt-dlp status=$SUB_STATUS"
    echo "  last errors:"
    tail -12 "$STDERR_LOG"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    SKIPPED_NO_SUBTITLES_COUNT=$((SKIPPED_NO_SUBTITLES_COUNT + 1))
    continue
  fi

  RAW_BASE="$(basename "$SUB_FILE")"
  OUT_BASE="${RAW_BASE%.*}.txt"
  META_BASE="${RAW_BASE%.*}.meta.json"
  OUT_FILE="$TEXT_DIR/$OUT_BASE"
  META_FILE="$TEXT_DIR/$META_BASE"

  clean_subtitle_to_text "$SUB_FILE" "$OUT_FILE"

  if [ ! -s "$OUT_FILE" ]; then
    echo "  cleaned transcript is empty, skipped"
    rm -f "$OUT_FILE"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    SKIPPED_NO_SUBTITLES_COUNT=$((SKIPPED_NO_SUBTITLES_COUNT + 1))
    continue
  fi

  WORDS="$(wc -w < "$OUT_FILE" | tr -d ' ')"
  CHARS="$(wc -c < "$OUT_FILE" | tr -d ' ')"
  TITLE_GUESS="$(basename "$OUT_FILE" .txt | sed -E "s#^[0-9]{8}_${VIDEO_ID}_##; s#_# #g")"

  write_meta_json \
    "$META_FILE" \
    "$CHANNEL_URL" \
    "$CHANNEL_FOLDER" \
    "$VIDEO_URL" \
    "$VIDEO_ID" \
    "$TITLE_GUESS" \
    "$SUB_FILE" \
    "$OUT_FILE" \
    "$WORDS" \
    "$CHARS" \
    "$SUB_STATUS" \
    "none"

  append_manifest_jsonl \
    "$MANIFEST_FILE" \
    "$VIDEO_ID" \
    "$TITLE_GUESS" \
    "$VIDEO_URL" \
    "$OUT_FILE" \
    "$WORDS" \
    "$CHARS"

  TRANSCRIPT_COUNT=$((TRANSCRIPT_COUNT + 1))

  echo "  saved: $OUT_FILE"
  echo "  meta:  $META_FILE"
  echo "  words=$WORDS chars=$CHARS"

  sleep "${FLOKI_YT_PER_VIDEO_SLEEP:-0.5}"
done < "$URL_LIST"

if [ "$TRANSCRIPT_COUNT" -gt 0 ]; then
  write_report_json "$REPORT_FILE" true "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_PASS"
  cat "$REPORT_FILE"
  echo
  echo "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_PASS"
  exit 0
fi

if [ "$SKIPPED_MEMBERS_COUNT" -gt 0 ]; then
  write_report_json "$REPORT_FILE" false "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_EMPTY_MEMBERS_SKIPPED"
  cat "$REPORT_FILE"
  echo
  echo "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_EMPTY_MEMBERS_SKIPPED"
  exit 4
fi

write_report_json "$REPORT_FILE" false "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_EMPTY_OR_NO_SUBTITLES"
cat "$REPORT_FILE"
echo
echo "FLOKI_YOUTUBE_PUBLIC_TRANSCRIPT_SCRAPE_EMPTY_OR_NO_SUBTITLES"
exit 4
