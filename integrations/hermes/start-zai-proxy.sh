#!/usr/bin/env bash
# Hermes proxy for Z.AI (zai_proxy.py). Usage: ./start-zai-proxy.sh [--port 8645]
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-with-hermes.sh" zai_proxy.py "$@"
