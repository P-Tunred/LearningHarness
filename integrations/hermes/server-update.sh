#!/bin/bash
# Hourly self-update for the Hermes proxy on the server (fork addition).
# Run by learnharness-update.timer (see server-setup.sh): pulls the repo and,
# only when integrations/hermes changed, runs the tests and restarts the proxy.
# A failing test keeps the running proxy on the old code.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE="${LH_PROXY_SERVICE:-learnharness-codex-proxy.service}"
cd "$REPO" || exit 1

before="$(git rev-parse HEAD)"
if ! git pull --ff-only --quiet; then
	echo "update: git pull failed (offline or local changes) – keeping $before"
	exit 0
fi
after="$(git rev-parse HEAD)"
if [ "$before" = "$after" ]; then
	echo "update: already up to date ($after)"
	exit 0
fi
if git diff --quiet "$before" "$after" -- integrations/hermes; then
	echo "update: $before → $after, proxy files unchanged"
	exit 0
fi

# Same environment as the service (e.g. HERMES_PYTHON).
while IFS= read -r assignment; do
	[ -n "$assignment" ] && export "${assignment?}"
done < <(systemctl --user show -p Environment --value "$SERVICE" | tr ' ' '\n')

if "$REPO/integrations/hermes/run-with-hermes.sh" test_codex_proxy.py; then
	systemctl --user restart "$SERVICE"
	echo "update: $before → $after, tests OK, $SERVICE restarted"
else
	echo "update: $before → $after, TESTS FAILED – rolling back, proxy keeps running"
	git reset --hard --quiet "$before"
	exit 1
fi
