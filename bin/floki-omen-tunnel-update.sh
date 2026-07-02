#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
fail() { echo "FLOKI_V2_OMEN_TUNNEL_UPDATE_FAIL: $1" >&2; exit 1; }

UNIT_NAME="floki-omen-reverse-tunnel.service"
USER_UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_PATH="${USER_UNIT_DIR}/${UNIT_NAME}"
SAMPLE_PATH="${ROOT}/docs/floki-omen-reverse-tunnel.sample.service"

# Derive SSH target from the existing unit if it exists, otherwise chris-mccoll.
OMEN_SSH_TARGET="chris-mccoll"
if [ -f "$UNIT_PATH" ]; then
  LAST_TOKEN="$(tail -n 50 "$UNIT_PATH" | sed -n 's/.* //p' | tail -n 1)"
  if [ -n "$LAST_TOKEN" ] && [ "$LAST_TOKEN" != "default.target" ] && [ "$LAST_TOKEN" != "Restart=always" ] && [ "$LAST_TOKEN" != "\\" ]; then
    OMEN_SSH_TARGET="$LAST_TOKEN"
  fi
fi

mkdir -p "$USER_UNIT_DIR"

cat > "$UNIT_PATH" <<'EOF'
[Unit]
Description=Floki reverse SSH tunnel to Omen gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -NT \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o TCPKeepAlive=yes \
  -R 127.0.0.1:17701:127.0.0.1:7710 \
  -R 127.0.0.1:17702:127.0.0.1:7700 \
EOF
printf '  %s\n' "$OMEN_SSH_TARGET" >> "$UNIT_PATH"
cat >> "$UNIT_PATH" <<'EOF'
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

echo "FLOKI_V2_OMEN_TUNNEL_UPDATE_UNIT: $UNIT_PATH"

# Keep a versioned reference of the unit file content inside the repo.
mkdir -p "${SAMPLE_PATH%/*}"
cat > "$SAMPLE_PATH" <<'EOF'
[Unit]
Description=Floki reverse SSH tunnel to Omen gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/ssh -NT \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o TCPKeepAlive=yes \
  -R 127.0.0.1:17701:127.0.0.1:7710 \
  -R 127.0.0.1:17702:127.0.0.1:7700 \
  chris-mccoll
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

echo "FLOKI_V2_OMEN_TUNNEL_UPDATE_SAMPLE: $SAMPLE_PATH"

systemctl --user daemon-reload || fail "systemctl daemon-reload failed"

if systemctl --user is-enabled "$UNIT_NAME" >/dev/null 2>&1; then
  echo "FLOKI_V2_OMEN_TUNNEL_UPDATE_ALREADY_ENABLED: $UNIT_NAME"
else
  systemctl --user enable "$UNIT_NAME" || fail "systemctl enable failed"
fi

if systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1; then
  systemctl --user restart "$UNIT_NAME" || fail "systemctl restart failed"
else
  systemctl --user start "$UNIT_NAME" || fail "systemctl start failed"
fi

sleep 0.5
systemctl --user is-active "$UNIT_NAME" >/dev/null 2>&1 || fail "service did not become active"

echo "FLOKI_V2_OMEN_TUNNEL_UPDATE_PASS: $UNIT_NAME active"
