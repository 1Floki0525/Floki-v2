#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
NODE24="$ROOT/bin/floki-node24-run.sh"
SUPERVISOR_SCRIPT="$ROOT/src/control-plane/floki-control-supervisor.cjs"

UNIT_NAME="floki-control-supervisor.service"
USER_UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_PATH="$USER_UNIT_DIR/$UNIT_NAME"

fail() {
  printf 'FLOKI_V2_CONTROL_SUPERVISOR_INSTALL_FAIL: %s\n' "$1" >&2
  exit 1
}

[ -x "$NODE24" ] \
  || fail "Node 24 runner missing or not executable: $NODE24"
[ -f "$SUPERVISOR_SCRIPT" ] \
  || fail "supervisor source missing: $SUPERVISOR_SCRIPT"

for command_name in systemctl curl ss grep install
do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is missing: $command_name"
done

CONFIG_OUTPUT="$(
  bash "$NODE24" node - <<'NODE'
'use strict';

const path = require('node:path');
const {
  PROJECT_ROOT,
  getControlPlaneConfig
} = require('./src/config/floki-config.cjs');

const config = getControlPlaneConfig('chat');
const rawPublicKeyPath = config.supervisor_public_key_path;
const publicKeyPath = path.isAbsolute(rawPublicKeyPath)
  ? rawPublicKeyPath
  : path.resolve(PROJECT_ROOT, rawPublicKeyPath);

process.stdout.write([
  'host=' + config.supervisor_host,
  'port=' + String(config.supervisor_port),
  'public_key_path=' + publicKeyPath
].join('\n') + '\n');
NODE
)" || fail "could not read the chat control-plane configuration"

SUPERVISOR_HOST="$(printf '%s\n' "$CONFIG_OUTPUT" | sed -n 's/^host=//p')"
SUPERVISOR_PORT="$(printf '%s\n' "$CONFIG_OUTPUT" | sed -n 's/^port=//p')"
PUBLIC_KEY_PATH="$(printf '%s\n' "$CONFIG_OUTPUT" | sed -n 's/^public_key_path=//p')"

[ "$SUPERVISOR_HOST" = "127.0.0.1" ] \
  || fail "supervisor host must be 127.0.0.1"

case "$SUPERVISOR_PORT" in
  ''|*[!0-9]*) fail "supervisor port must be an integer" ;;
esac

[ "$SUPERVISOR_PORT" -ge 1 ] &&
[ "$SUPERVISOR_PORT" -le 65535 ] \
  || fail "supervisor port must be between 1 and 65535"

[ -f "$PUBLIC_KEY_PATH" ] \
  || fail "public verification key is missing: $PUBLIC_KEY_PATH. Generate the keypair on Omen and securely copy only the public key to this path."

[ ! -L "$PUBLIC_KEY_PATH" ] \
  || fail "public verification key must not be a symbolic link"

bash "$NODE24" node - "$PUBLIC_KEY_PATH" <<'NODE'
'use strict';

const fs = require('node:fs');

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8').trim();

if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) {
  process.stderr.write('public key file is not canonical 32-byte base64\n');
  process.exit(1);
}

const raw = Buffer.from(text, 'base64');
if (raw.length !== 32) {
  process.stderr.write('public key file does not decode to 32 bytes\n');
  process.exit(1);
}
NODE

install -d -m 0700 -- "$USER_UNIT_DIR"

UNIT_TMP="$USER_UNIT_DIR/.${UNIT_NAME}.$$.tmp"
cleanup() {
  rm -f -- "$UNIT_TMP"
}
trap cleanup EXIT HUP INT TERM

cat > "$UNIT_TMP" <<EOF
[Unit]
Description=Floki-v2 out-of-process lifecycle supervisor
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE24 node $SUPERVISOR_SCRIPT $PUBLIC_KEY_PATH
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
Environment=FLOKI_CONTROL_PLANE_PUBLIC_KEY=$PUBLIC_KEY_PATH
Environment=FLOKI_CONTROL_SUPERVISOR_BIND_HOST=127.0.0.1
Environment=FLOKI_CONTROL_SUPERVISOR_BIND_PORT=$SUPERVISOR_PORT

[Install]
WantedBy=default.target
EOF

chmod 0644 -- "$UNIT_TMP"

if grep -qiE \
  'supervisor_private_key|private_key_base64|BEGIN[ ]+PRIVATE[ ]+KEY|keygen' \
  "$UNIT_TMP"
then
  fail "generated unit unexpectedly references private-key material"
fi

mv -fT -- "$UNIT_TMP" "$UNIT_PATH"
chmod 0644 -- "$UNIT_PATH"
trap - EXIT HUP INT TERM

systemctl --user daemon-reload \
  || fail "systemd user daemon-reload failed"

systemctl --user enable "$UNIT_NAME" >/dev/null \
  || fail "could not enable $UNIT_NAME"

if systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1
then
  systemctl --user restart "$UNIT_NAME" \
    || fail "could not restart the existing supervisor service"
else
  systemctl --user start "$UNIT_NAME" \
    || fail "could not start the supervisor service"
fi

READY=0
HEALTH=""
ATTEMPT=1
MAX_ATTEMPTS=80

while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  if systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; then
    HEALTH="$(
      curl \
        --silent \
        --show-error \
        --fail \
        --max-time 1 \
        "http://127.0.0.1:${SUPERVISOR_PORT}/health" \
        2>/dev/null || true
    )"

    if [ -n "$HEALTH" ] &&
       bash "$NODE24" node -e '
         "use strict";
         const payload = JSON.parse(process.argv[1]);
         if (payload.ok !== true) process.exit(1);
       ' "$HEALTH" >/dev/null 2>&1
    then
      READY=1
      break
    fi
  fi

  sleep 0.25
  ATTEMPT=$((ATTEMPT + 1))
done

if [ "$READY" -ne 1 ]; then
  systemctl --user status "$UNIT_NAME" \
    --no-pager \
    --full >&2 2>&1 || true
  journalctl --user \
    --unit "$UNIT_NAME" \
    --no-pager \
    -n 80 >&2 2>&1 || true
  fail "supervisor did not become healthy on 127.0.0.1:${SUPERVISOR_PORT} after ${MAX_ATTEMPTS} readiness checks"
fi

LISTENERS="$(
  ss -ltnH 2>/dev/null |
  awk -v port="$SUPERVISOR_PORT" '$4 ~ (":" port "$") { print $4 }'
)"

[ "$LISTENERS" = "127.0.0.1:${SUPERVISOR_PORT}" ] \
  || fail "supervisor must have exactly one IPv4 loopback listener; observed: ${LISTENERS:-none}"

for candidate in \
  "$ROOT/state/floki/control-plane/supervisor.key" \
  "$ROOT/state/floki/control-plane/supervisor.pem" \
  "$ROOT/state/floki/control-plane/private.key" \
  "$ROOT/state/floki/control-plane/private.pem"
do
  [ ! -e "$candidate" ] && [ ! -L "$candidate" ] \
    || fail "private key material exists on workstation: $candidate"
done

printf '%s\n' "FLOKI_V2_CONTROL_SUPERVISOR_INSTALL_PASS"
printf 'service=%s\n' "$UNIT_NAME"
printf 'unit_path=%s\n' "$UNIT_PATH"
printf 'listener=%s:%s\n' "$SUPERVISOR_HOST" "$SUPERVISOR_PORT"
printf 'public_key_path=%s\n' "$PUBLIC_KEY_PATH"
printf '%s\n' "private_key_present_on_workstation=false"
