#!/bin/bash
# Creates the "LearnHarness (Hermes)" icon in ~/Applications (fork addition).
# Run once in Terminal, from anywhere:
#   ~/LearningHarness/integrations/mac/install-launcher.sh root@<server-ip>
# The argument is the SSH login of the server where Hermes runs (leave it out
# when Hermes runs on this Mac). Then drag the icon into the Dock.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STARTER="$REPO/integrations/mac/start-learnharness.sh"
APP="$HOME/Applications/LearnHarness (Hermes).app"
CONFIG_DIR="$HOME/.config/learnharness"
SSH_TARGET="${1:-}"

for tool in git node npm osacompile; do
	command -v "$tool" >/dev/null || { echo "Fehlt: $tool – bitte zuerst installieren." >&2; exit 1; }
done

if [ -n "$SSH_TARGET" ]; then
	echo "Prüfe die SSH-Verbindung zu $SSH_TARGET …"
	if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" true; then
		echo "SSH ohne Passwort klappt nicht. Erst 'ssh $SSH_TARGET' im Terminal testen." >&2
		exit 1
	fi
fi

mkdir -p "$CONFIG_DIR" "$HOME/Applications"
# This Terminal's PATH (with node/npm) for starts from the Dock.
{
	printf 'LH_REPO=%q\n' "$REPO"
	printf 'LH_PATH=%q\n' "$PATH"
	printf 'LH_HERMES_SSH=%q\n' "$SSH_TARGET"
	printf 'LH_HERMES_PORT=8646\n'
} >"$CONFIG_DIR/launcher.env"
chmod 600 "$CONFIG_DIR/launcher.env"
chmod +x "$STARTER"

rm -rf "$APP"
osacompile -o "$APP" -e "do shell script \"/bin/bash \" & quoted form of \"$STARTER\" & \" >/dev/null 2>&1 &\""
if [ -f "$REPO/build/icon.icns" ]; then
	cp "$REPO/build/icon.icns" "$APP/Contents/Resources/applet.icns"
	touch "$APP"
fi

echo
echo "Fertig: $APP"
echo "Zieh das Symbol ins Dock. Ein Klick startet LearnHarness inkl. Update und Hermes-Verbindung."
echo "Beenden mit Cmd+Q. Log: ~/Library/Logs/LearnHarness-launcher.log"
open -R "$APP" || true
