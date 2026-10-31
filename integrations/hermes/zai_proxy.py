"""Hermes proxy for Z.AI (GLM): LearnHarness → Hermes → Z.AI.

Hermes ships a local "subscription proxy" (``hermes proxy start``) that
forwards OpenAI-compatible requests verbatim and attaches the credential
Hermes manages. Its built-in upstreams are only Nous Portal and xAI. This
launcher adds a Z.AI upstream WITHOUT modifying Hermes: it reuses Hermes'
own proxy server, ``.env`` loading and ``zai`` credential pool (the
``GLM_API_KEY`` / ``ZAI_API_KEY`` you configured for Hermes, including its
Coding-Plan endpoint detection or ``GLM_BASE_URL`` override).

Run it with the Python interpreter of your Hermes installation — the
``start-zai-proxy.sh`` wrapper next to this file finds it for you. Then point
LearnHarness at it: Settings → Providers → Custom endpoint →
``http://127.0.0.1:8645/v1`` (Keyless).

Request and response bodies pass through unchanged (tools, tool calls and
streaming included); the proxy binds 127.0.0.1 only.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import threading
from typing import Optional

try:
    from agent.credential_pool import CredentialPool, PooledCredential, load_pool
    from hermes_cli.env_loader import load_hermes_dotenv
    from hermes_cli.proxy.adapters.base import UpstreamAdapter, UpstreamCredential
    from hermes_cli.proxy.server import AIOHTTP_AVAILABLE, DEFAULT_HOST, DEFAULT_PORT, run_server
except ImportError as exc:  # pragma: no cover - depends on the user's install
    sys.exit(
        "Hermes Agent was not found in this Python environment "
        f"({exc}). Start this file with Hermes' own Python, e.g. via start-zai-proxy.sh."
    )

logger = logging.getLogger("learnharness.zai_proxy")

POOL_PROVIDER = "zai"
# Z.AI's general endpoint; the pool usually resolves the Coding-Plan URL instead.
FALLBACK_BASE_URL = "https://api.z.ai/api/paas/v4"
# Paths LearnHarness' custom endpoint uses (chat + model discovery).
ALLOWED_PATHS: frozenset[str] = frozenset({"/chat/completions", "/models"})


class ZaiAdapter(UpstreamAdapter):
    """Proxy upstream for Z.AI via Hermes' ``zai`` credential pool."""

    auth_hint = "hermes setup  (or add GLM_API_KEY to ~/.hermes/.env)"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pool: Optional[CredentialPool] = None

    @property
    def name(self) -> str:
        return "zai"

    @property
    def display_name(self) -> str:
        return "Z.AI / GLM (via Hermes)"

    @property
    def allowed_paths(self) -> frozenset[str]:
        return ALLOWED_PATHS

    def is_authenticated(self) -> bool:
        pool = self._load_pool()
        return bool(pool and pool.has_available())

    def get_credential(self) -> UpstreamCredential:
        with self._lock:
            pool = self._load_pool()
            if pool is None or not pool.has_credentials():
                raise RuntimeError(f"No Z.AI key configured in Hermes. Run `{self.auth_hint}`.")
            entry = pool.select()
            if entry is None:
                raise RuntimeError("All Z.AI keys in Hermes are currently exhausted or rate-limited.")
            self._pool = pool
            return self._credential_from_entry(entry)

    def get_retry_credential(
        self, *, failed_credential: UpstreamCredential, status_code: int
    ) -> Optional[UpstreamCredential]:
        # Static API keys cannot be refreshed; on 429 rotate to another pooled key if there is one.
        if status_code != 429:
            return None
        with self._lock:
            pool = self._pool or self._load_pool()
            if pool is None:
                return None
            rotated = pool.mark_exhausted_and_rotate(status_code=status_code)
            if rotated is None:
                return None
            retry = self._credential_from_entry(rotated)
            return None if retry.bearer == failed_credential.bearer else retry

    def _load_pool(self) -> Optional[CredentialPool]:
        try:
            return load_pool(POOL_PROVIDER)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("failed to load Hermes' Z.AI credential pool: %s", exc)
            return None

    @staticmethod
    def _credential_from_entry(entry: PooledCredential) -> UpstreamCredential:
        bearer = str(getattr(entry, "runtime_api_key", None) or entry.access_token or "").strip()
        if not bearer:
            raise RuntimeError("The Z.AI entry in Hermes has no API key.")
        base_url = str(
            getattr(entry, "runtime_base_url", None) or entry.base_url or FALLBACK_BASE_URL
        ).strip().rstrip("/")
        return UpstreamCredential(bearer=bearer, base_url=base_url or FALLBACK_BASE_URL)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes proxy for Z.AI (for LearnHarness)")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"bind address (default {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port (default {DEFAULT_PORT})")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if not AIOHTTP_AVAILABLE:
        print("Hermes' proxy needs aiohttp. Run `hermes setup` (or install aiohttp into Hermes' Python).",
              file=sys.stderr)
        return 1
    load_hermes_dotenv()  # ~/.hermes/.env — the same keys Hermes itself uses

    adapter = ZaiAdapter()
    if not adapter.is_authenticated():
        print(f"No Z.AI key found in Hermes. Run: {adapter.auth_hint}", file=sys.stderr)
        return 1
    upstream = adapter.get_credential().base_url
    print(
        f"Hermes proxy for {adapter.display_name}\n"
        f"  Listening on:  http://{args.host}:{args.port}/v1\n"
        f"  Forwarding to: {upstream}\n"
        "  In LearnHarness: Settings → Providers → Custom endpoint → this URL, Keyless.\n"
        "  Stop with Ctrl+C."
    )
    try:
        asyncio.run(run_server(adapter, host=args.host, port=args.port))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
