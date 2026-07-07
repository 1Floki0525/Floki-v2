#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK_PATH="${SCRIPT_DIR}/app/build/outputs/apk/debug/app-debug.apk"

if ! command -v adb >/dev/null 2>&1; then
  echo "ERROR: adb is not installed or not on PATH" >&2
  exit 1
fi

DEVICES="$(adb devices 2>/dev/null | grep -v '^List' | grep -v '^$' || true)"
if [ -z "$DEVICES" ]; then
  echo "ERROR: No Android devices connected" >&2
  exit 1
fi

DEVICE_COUNT="$(echo "$DEVICES" | wc -l)"
echo "Connected devices:"
echo "$DEVICES"
echo ""

if [ "$DEVICE_COUNT" -gt 1 ]; then
  SERIAL="$(echo "$DEVICES" | head -1 | awk '{print $1}')"
  echo "Multiple devices found. Using first: $SERIAL"
  ADB_CMD="adb -s $SERIAL"
else
  SERIAL="$(echo "$DEVICES" | awk '{print $1}')"
  STATE="$(echo "$DEVICES" | awk '{print $2}')"
  if [ "$STATE" != "device" ]; then
    echo "ERROR: Device $SERIAL is $STATE (not authorized or offline)" >&2
    exit 1
  fi
  ADB_CMD="adb -s $SERIAL"
fi

if [ ! -f "$APK_PATH" ]; then
  echo "ERROR: APK not found at $APK_PATH" >&2
  echo "Build first: cd apps/Floki-mobile-app && ./gradlew :app:assembleDebug" >&2
  exit 1
fi

echo "Installing: $APK_PATH"
echo "Target:     $SERIAL"
echo ""

$ADB_CMD install -r "$APK_PATH"
echo ""
echo "APK path: $APK_PATH"
echo "Done."
