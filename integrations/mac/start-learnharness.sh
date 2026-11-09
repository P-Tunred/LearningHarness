#!/bin/bash
# LearnHarness starter for this Mac (fork addition). Started by the
# "LearnHarness (Hermes)" icon that install-launcher.sh creates. One click:
#   1. fetch the newest version from GitHub (git pull, quietly)
#   2. install dependencies, only when they changed
#   3. open the SSH tunnel to Hermes' proxy on the server (reconnects if it drops)
#   4. start LearnHarness; quitting it (Cmd+Q) also closes the tunnel
# Settings: ~/.config/learnharness/launcher.env (written by install-launcher.sh)
# Log:      ~/Library/Logs/LearnHarness-launcher.log
set -u

CONFIG_DIR="$HOME/.config/learnharness"
CONFIG="$CONFIG_DIR/launcher.env"
LOG="$HOME/Library/Logs/LearnHarness-launcher.log"
LOCK="$CONFIG_DIR/launcher.pid"
mkdir -p "$CONFIG_DIR" "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') start"

# shellcheck source=/dev/null
[ -f "$CONFIG" ] && . "$CONFIG"
# Apps started from the Dock get a minimal PATH; use the one recorded at install time.
export PATH="${LH_PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}"
REPO="${LH_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
PORT="${LH_HERMES_PORT:-8646}"

notify() {
	echo "notify: $1"
	osascript -e "display notification \"$1\" with title \"LearnHarness\"" >/dev/null 2>&1 || true
}

cd "$REPO" || { notify "Ordner nicht gefunden: $REPO"; exit 1; }

# Only one instance: a second click while it runs just says so.
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
	notify "LearnHarness läuft schon."
	exit 0
fi
echo $$ >"$LOCK"
notify "LearnHarness startet…"

TUNNEL_PID=""
SYNC_PID=""
cleanup() {
	for pid in "$TUNNEL_PID" "$SYNC_PID"; do
		if [ -n "$pid" ]; then
			# Note what the loop runs (ssh, sleep, a copy), stop the loop so it
			# cannot start another round, then stop what it ran.
			kids="$(pgrep -P "$pid" 2>/dev/null || true)"
			kill "$pid" 2>/dev/null
			# shellcheck disable=SC2086
			[ -n "$kids" ] && kill $kids 2>/dev/null
		fi
	done
	rm -f "$LOCK"
	echo "=== $(date '+%Y-%m-%d %H:%M:%S') stop"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

# 1. Update (never blocks the start: offline or local changes → current version).
if git pull --ff-only --quiet; then
	echo "updated to $(git rev-parse --short HEAD)"
else
	notify "Kein Update möglich – starte die vorhandene Version."
fi

# 2. Dependencies, only when package-lock.json changed.
STAMP=".git/learnharness-deps.sha"
SUM="$(shasum package-lock.json | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$SUM" ]; then
	notify "Installiere Updates… das kann 2–3 Minuten dauern."
	if npm ci --no-audit --no-fund; then
		echo "$SUM" >"$STAMP"
	else
		notify "Installation fehlgeschlagen – Details im Log."
	fi
fi

# 3. Tunnel to Hermes (key-based SSH; reconnects after network drops).
if [ -n "${LH_HERMES_SSH:-}" ]; then
	if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
		echo "port $PORT already open – using the existing tunnel"
	else
		(
			while true; do
				ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
					-o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
					-L "127.0.0.1:$PORT:127.0.0.1:$PORT" "$LH_HERMES_SSH"
				echo "tunnel closed (exit $?) – reconnecting in 5 s"
				sleep 5
			done
		) &
		TUNNEL_PID=$!
		for _ in 1 2 3 4 5 6 7 8 9 10; do
			nc -z 127.0.0.1 "$PORT" 2>/dev/null && break
			sleep 1
		done
		nc -z 127.0.0.1 "$PORT" 2>/dev/null || notify "Keine Verbindung zu Hermes – LearnHarness startet trotzdem."
	fi
fi

# 3b. Subject materials iCloud → Google Drive for Hermes (integrations/mac/
#     subject-sync.sh): now and every 15 min while LearnHarness is open.
if [ -s "$CONFIG_DIR/subjects.conf" ]; then
	(
		while true; do
			bash "$REPO/integrations/mac/subject-sync.sh" once || echo "subject-sync failed (exit $?)"
			sleep 900
		done
	) &
	SYNC_PID=$!
fi

# 4. LearnHarness (the window opens by itself; Cmd+Q ends everything).
npm run desktop:dev
