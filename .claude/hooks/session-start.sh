#!/bin/bash
# SessionStart hook (fork addition): makes every Claude Code session ready to
# work on LearnHarness with graphify.
#   Cloud sessions (CLAUDE_CODE_REMOTE=true):
#     1. npm dependencies — only when package.json / package-lock.json / this
#        script changed since the last successful install
#     2. the graphify CLI (PyPI "graphifyy") — only when it is missing
#   Everywhere graphify is installed (cloud and local):
#     3. graphify update . — incremental, AST-only code graph in graphify-out/
# GRAPHIFY_BACKEND=none keeps graphify from calling an LLM (community labels,
# semantic passes), so the graph never costs tokens.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

persist() {
	if [ -n "${CLAUDE_ENV_FILE:-}" ]; then echo "$1" >>"$CLAUDE_ENV_FILE"; fi
}

export GRAPHIFY_BACKEND=none
persist 'export GRAPHIFY_BACKEND=none'

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
	# 1. npm dependencies (hash file lives in the git-ignored node_modules).
	hashes=node_modules/.session-start.sha256
	if ! sha256sum --check --status "$hashes" 2>/dev/null; then
		rm -f "$hashes"
		npm ci --no-audit --no-fund >&2
		sha256sum .claude/hooks/session-start.sh package.json package-lock.json >"$hashes"
	fi

	# 2. graphify CLI (a global tool: checked by presence, not by hash).
	if command -v uv >/dev/null 2>&1; then
		bin="$(uv tool dir --bin)"
		export PATH="$bin:$PATH"
		persist "export PATH=\"$bin:\$PATH\""
	fi
	if ! command -v graphify >/dev/null 2>&1; then
		if command -v uv >/dev/null 2>&1; then
			uv tool install -q graphifyy >&2
		elif command -v pipx >/dev/null 2>&1; then
			pipx install graphifyy >&2
		else
			python3 -m pip install --user -q graphifyy >&2
			export PATH="$HOME/.local/bin:$PATH"
			persist "export PATH=\"\$HOME/.local/bin:\$PATH\""
		fi
	fi
fi

# 3. The code graph (incremental; --force: it is derived per session, so a
#    smaller graph after deletions is expected, not an error).
if command -v graphify >/dev/null 2>&1; then
	if graphify update . --force >/dev/null 2>&1; then
		echo "graphify: code graph ready in graphify-out/ (use graphify query/path/explain)"
	else
		echo "graphify: graph update failed — run 'graphify update .' to see why" >&2
	fi
fi
