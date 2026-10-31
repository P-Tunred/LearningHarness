#!/bin/bash
# One-time server setup for the Hermes proxy (fork addition). Run on the
# server, after cloning the repo with the deploy key:
#   bash ~/LearningHarness/integrations/hermes/server-setup.sh
# It
#   1. makes git in this repo always use the deploy key (no ~/.ssh/config change)
#   2. runs the proxy tests with Hermes' Python
#   3. switches learnharness-codex-proxy.service to the combined proxy
#      (ChatGPT + Z.AI) via a drop-in, keeping the unit's own settings
#   4. installs learnharness-update.timer: hourly self-update (server-update.sh)
#   5. shows the model list the proxy now serves
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/integrations/hermes"
SERVICE="${LH_PROXY_SERVICE:-learnharness-codex-proxy.service}"
KEY="${LH_DEPLOY_KEY:-$HOME/.ssh/learnharness_deploy}"
UNIT_DIR="$HOME/.config/systemd/user"
PORT=8646

echo "1/5  Git: Deploy key für dieses Repo"
[ -f "$KEY" ] || { echo "Deploy key $KEY fehlt." >&2; exit 1; }
git -C "$REPO" config core.sshCommand "ssh -i $KEY -o IdentitiesOnly=yes"
git -C "$REPO" pull --ff-only --quiet
chmod +x "$HERE"/*.sh

echo "2/5  Tests"
if systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
	while IFS= read -r assignment; do
		[ -n "$assignment" ] && export "${assignment?}"
	done < <(systemctl --user show -p Environment --value "$SERVICE" | tr ' ' '\n')
fi
"$HERE/run-with-hermes.sh" test_codex_proxy.py

echo "3/5  Dienst auf den gemeinsamen Proxy umstellen"
mkdir -p "$UNIT_DIR/$SERVICE.d"
cat >"$UNIT_DIR/$SERVICE.d/learnharness.conf" <<EOF
[Service]
ExecStart=
ExecStart=$HERE/start-hermes-proxy.sh --port $PORT
Restart=always
EOF
if ! systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
	cat >"$UNIT_DIR/$SERVICE" <<EOF
[Unit]
Description=LearnHarness proxy (Hermes: ChatGPT + Z.AI)
After=network-online.target

[Service]
ExecStart=$HERE/start-hermes-proxy.sh --port $PORT
Restart=always

[Install]
WantedBy=default.target
EOF
fi

echo "4/5  Stündliche Updates"
cat >"$UNIT_DIR/learnharness-update.service" <<EOF
[Unit]
Description=LearnHarness proxy self-update

[Service]
Type=oneshot
Environment=LH_PROXY_SERVICE=$SERVICE
ExecStart=$HERE/server-update.sh
EOF
cat >"$UNIT_DIR/learnharness-update.timer" <<EOF
[Unit]
Description=Hourly LearnHarness proxy self-update

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE" >/dev/null 2>&1 || true
systemctl --user restart "$SERVICE"
systemctl --user enable --now learnharness-update.timer
loginctl enable-linger "$(id -un)" 2>/dev/null || true

echo "5/5  Prüfen"
for _ in $(seq 1 20); do
	curl -s -o /dev/null "http://127.0.0.1:$PORT/v1/models" && break
	sleep 1
done
journalctl --user -u "$SERVICE" -n 8 --no-pager | grep -E "ChatGPT|Z.AI|Listening" || true
echo
curl -s "http://127.0.0.1:$PORT/v1/models"
echo
echo
echo "Fertig. Updates: systemctl --user list-timers learnharness-update.timer"
echo "Logs:    journalctl --user -u $SERVICE -f"
