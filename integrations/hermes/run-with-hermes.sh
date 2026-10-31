#!/usr/bin/env bash
# Runs a Python script with the Python of your Hermes installation.
# Usage:  ./run-with-hermes.sh <script.py> [args…]
# Override the interpreter with HERMES_PYTHON=/path/to/python if needed.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -ge 1 ] || { echo "usage: $0 <script.py> [args…]" >&2; exit 2; }

has_hermes() { [ -n "$1" ] && "$1" -c "import hermes_cli.proxy.server" >/dev/null 2>&1; }

py="${HERMES_PYTHON:-}"
if ! has_hermes "$py"; then
	py=""
	# The `hermes` command's own interpreter (pip/uv installs put it in the shebang).
	if hermes_bin="$(command -v hermes 2>/dev/null)"; then
		shebang="$(head -n1 "$hermes_bin" | sed -n 's/^#!\s*//p' | awk '{print $1}')"
		if has_hermes "$shebang"; then py="$shebang"; fi
	fi
fi
if [ -z "$py" ]; then
	for candidate in "$HOME/.hermes/hermes-agent/.venv/bin/python" "$HOME/.hermes/hermes-agent/venv/bin/python" python3; do
		if has_hermes "$candidate"; then py="$candidate"; break; fi
	done
fi
if [ -z "$py" ]; then
	echo "Could not find the Python of your Hermes installation." >&2
	echo "Set it explicitly, e.g.: HERMES_PYTHON=/path/to/hermes/venv/bin/python $0" >&2
	exit 1
fi
script="$1"; shift
exec "$py" "$here/$script" "$@"
