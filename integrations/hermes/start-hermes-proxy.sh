#!/usr/bin/env bash
# One Hermes proxy for ChatGPT + Z.AI (hermes_proxy.py). Usage: ./start-hermes-proxy.sh [--port 8646]
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-with-hermes.sh" hermes_proxy.py "$@"
