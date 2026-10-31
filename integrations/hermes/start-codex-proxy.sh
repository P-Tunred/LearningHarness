#!/usr/bin/env bash
# Hermes proxy for the ChatGPT subscription (codex_proxy.py). Usage: ./start-codex-proxy.sh [--port 8646]
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-with-hermes.sh" codex_proxy.py "$@"
