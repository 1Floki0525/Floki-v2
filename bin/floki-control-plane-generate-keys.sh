#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'FLOKI_V2_CONTROL_PLANE_KEYGEN_FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  floki-control-plane-generate-keys.sh \
    --private-key /absolute/secure/path/floki-control-plane-private.pem \
    --public-key /absolute/path/floki-control-plane-public.key \
    [--force]

Generate an Ed25519 keypair without printing private key material.

This script is standalone and requires OpenSSL plus standard coreutils.
It is intended to be copied to and run on the Omen gateway.

Security rules:
  - The private key path must be absolute.
  - The private key path must not be under /tmp, /var/tmp, or /run.
  - When run from a Git checkout, the private key must be outside it.
  - The private key is written with mode 0600.
  - The public raw 32-byte verification key is base64 and mode 0644.
  - No private key bytes are written to stdout, stderr, logs, or Git.
EOF
}

PRIVATE_KEY_PATH=""
PUBLIC_KEY_PATH=""
FORCE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --private-key)
      [ -n "${2:-}" ] || fail "--private-key requires a value"
      PRIVATE_KEY_PATH="$2"
      shift 2
      ;;
    --public-key)
      [ -n "${2:-}" ] || fail "--public-key requires a value"
      PUBLIC_KEY_PATH="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$PRIVATE_KEY_PATH" ] || fail "--private-key is required"
[ -n "$PUBLIC_KEY_PATH" ] || fail "--public-key is required"

case "$PRIVATE_KEY_PATH" in
  /*) ;;
  *) fail "--private-key must be an absolute path" ;;
esac

case "$PUBLIC_KEY_PATH" in
  /*) ;;
  *) fail "--public-key must be an absolute path" ;;
esac

for command_name in \
  openssl install mktemp od tail base64 sha256sum readlink stat awk tr wc
do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is missing: $command_name"
done

PRIVATE_KEY_PATH="$(readlink -m -- "$PRIVATE_KEY_PATH")"
PUBLIC_KEY_PATH="$(readlink -m -- "$PUBLIC_KEY_PATH")"

[ "$PRIVATE_KEY_PATH" != "$PUBLIC_KEY_PATH" ] \
  || fail "private and public key paths must differ"

case "$PRIVATE_KEY_PATH" in
  /tmp|/tmp/*|/var/tmp|/var/tmp/*|/run|/run/*)
    fail "private key must not be stored in a temporary runtime directory"
    ;;
esac

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
if command -v git >/dev/null 2>&1; then
  GIT_ROOT="$(
    git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true
  )"
  if [ -n "$GIT_ROOT" ]; then
    GIT_ROOT="$(readlink -m -- "$GIT_ROOT")"
    case "$PRIVATE_KEY_PATH" in
      "$GIT_ROOT"|"$GIT_ROOT"/*)
        fail "private key must be outside the Git repository"
        ;;
    esac
  fi
fi

if [ "$FORCE" -ne 1 ]; then
  [ ! -e "$PRIVATE_KEY_PATH" ] \
    || fail "private key already exists; use --force only for intentional rotation"
  [ ! -e "$PUBLIC_KEY_PATH" ] \
    || fail "public key already exists; use --force only for intentional rotation"
fi

[ ! -L "$PRIVATE_KEY_PATH" ] \
  || fail "private key target must not be a symbolic link"
[ ! -L "$PUBLIC_KEY_PATH" ] \
  || fail "public key target must not be a symbolic link"

PRIVATE_DIR="$(dirname -- "$PRIVATE_KEY_PATH")"
PUBLIC_DIR="$(dirname -- "$PUBLIC_KEY_PATH")"

install -d -m 0700 -- "$PRIVATE_DIR"
install -d -m 0755 -- "$PUBLIC_DIR"

WORK_DIR="$(mktemp -d "$PRIVATE_DIR/.floki-control-plane-keygen.XXXXXX")"
TMP_PRIVATE="$WORK_DIR/private.pem"
TMP_PUBLIC_DER="$WORK_DIR/public.der"
TMP_PUBLIC_RAW="$WORK_DIR/public.key"
PRIVATE_INSTALL_TMP="$PRIVATE_DIR/.floki-control-plane-private.$$.tmp"
PUBLIC_INSTALL_TMP="$PUBLIC_DIR/.floki-control-plane-public.$$.tmp"

cleanup() {
  rm -f -- "$PRIVATE_INSTALL_TMP" "$PUBLIC_INSTALL_TMP"
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

openssl genpkey \
  -algorithm Ed25519 \
  -out "$TMP_PRIVATE" \
  >/dev/null 2>&1 \
  || fail "Ed25519 private key generation failed"

chmod 0600 -- "$TMP_PRIVATE"

openssl pkey \
  -in "$TMP_PRIVATE" \
  -pubout \
  -outform DER \
  -out "$TMP_PUBLIC_DER" \
  >/dev/null 2>&1 \
  || fail "Ed25519 public key extraction failed"

DER_SIZE="$(wc -c < "$TMP_PUBLIC_DER" | tr -d '[:space:]')"
[ "$DER_SIZE" = "44" ] \
  || fail "unexpected Ed25519 SubjectPublicKeyInfo size: $DER_SIZE"

DER_PREFIX="$(
  od -An -tx1 -N12 "$TMP_PUBLIC_DER" |
  tr -d ' \n'
)"
[ "$DER_PREFIX" = "302a300506032b6570032100" ] \
  || fail "unexpected Ed25519 SubjectPublicKeyInfo prefix"

tail -c 32 "$TMP_PUBLIC_DER" |
  base64 -w 0 > "$TMP_PUBLIC_RAW"
printf '\n' >> "$TMP_PUBLIC_RAW"
chmod 0600 -- "$TMP_PUBLIC_RAW"

PUBLIC_TEXT="$(tr -d '\n\r' < "$TMP_PUBLIC_RAW")"
[ "${#PUBLIC_TEXT}" -eq 44 ] \
  || fail "public verification key is not 44-character base64"

DECODED_SIZE="$(
  printf '%s' "$PUBLIC_TEXT" |
  base64 -d |
  wc -c |
  tr -d '[:space:]'
)"
[ "$DECODED_SIZE" = "32" ] \
  || fail "public verification key does not decode to 32 bytes"

install -m 0600 -- "$TMP_PRIVATE" "$PRIVATE_INSTALL_TMP"
install -m 0644 -- "$TMP_PUBLIC_RAW" "$PUBLIC_INSTALL_TMP"

mv -fT -- "$PRIVATE_INSTALL_TMP" "$PRIVATE_KEY_PATH"
mv -fT -- "$PUBLIC_INSTALL_TMP" "$PUBLIC_KEY_PATH"

chmod 0600 -- "$PRIVATE_KEY_PATH"
chmod 0644 -- "$PUBLIC_KEY_PATH"

PRIVATE_MODE="$(stat -c '%a' -- "$PRIVATE_KEY_PATH")"
PUBLIC_MODE="$(stat -c '%a' -- "$PUBLIC_KEY_PATH")"

[ "$PRIVATE_MODE" = "600" ] \
  || fail "private key mode is $PRIVATE_MODE instead of 600"
[ "$PUBLIC_MODE" = "644" ] \
  || fail "public key mode is $PUBLIC_MODE instead of 644"

DER_CHECK="$WORK_DIR/check.der"
RAW_CHECK="$WORK_DIR/check.key"

openssl pkey \
  -in "$PRIVATE_KEY_PATH" \
  -pubout \
  -outform DER \
  -out "$DER_CHECK" \
  >/dev/null 2>&1 \
  || fail "could not rederive public key from installed private key"

tail -c 32 "$DER_CHECK" |
  base64 -w 0 > "$RAW_CHECK"

[ "$(cat "$RAW_CHECK")" = "$PUBLIC_TEXT" ] \
  || fail "installed public key does not match installed private key"

PUBLIC_FINGERPRINT="$(
  sha256sum -- "$PUBLIC_KEY_PATH" |
  awk '{print $1}'
)"

printf '%s\n' "FLOKI_V2_CONTROL_PLANE_KEYGEN_PASS"
printf 'private_key_path=%s\n' "$PRIVATE_KEY_PATH"
printf 'private_key_mode=%s\n' "$PRIVATE_MODE"
printf 'public_key_path=%s\n' "$PUBLIC_KEY_PATH"
printf 'public_key_mode=%s\n' "$PUBLIC_MODE"
printf 'public_key_sha256=%s\n' "$PUBLIC_FINGERPRINT"
printf '%s\n' "private_key_material_was_not_printed=true"

trap - EXIT HUP INT TERM
cleanup
