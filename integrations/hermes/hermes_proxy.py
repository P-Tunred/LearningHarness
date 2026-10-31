"""One Hermes proxy for both subscriptions: LearnHarness → Hermes → ChatGPT *and* Z.AI.

LearnHarness has a single custom endpoint. This proxy offers the models of
both subscriptions Hermes manages on one URL and routes each request by its
model:

    GPT models  → codex_proxy.py's translation to the Codex backend (Hermes' ChatGPT login)
    GLM models  → passed through unchanged to Z.AI (Hermes' Z.AI key, see zai_proxy.py)

A subscription that is not set up in Hermes is simply left out of the model
list. Run with Hermes' Python (``start-hermes-proxy.sh``); binds 127.0.0.1.
In LearnHarness: Custom endpoint → ``http://127.0.0.1:8646/v1`` (Keyless).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import codex_proxy as codex  # noqa: E402  (also checks Hermes + aiohttp are present)
from aiohttp import web  # noqa: E402
from zai_proxy import ZaiAdapter  # noqa: E402

logger = logging.getLogger("learnharness.hermes_proxy")

DEFAULT_PORT = 8646
ZAI_FALLBACK_MODELS = ["glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5", "glm-5v-turbo", "glm-4.7"]


def zai_static_models() -> list[str]:
    """Hermes' curated Z.AI list (offline fallback when the endpoint lists nothing)."""
    try:
        from hermes_cli.models_catalog_static import _PROVIDER_MODELS
        models = list(_PROVIDER_MODELS.get("zai") or [])
        return models or ZAI_FALLBACK_MODELS
    except Exception:  # pragma: no cover - depends on the Hermes release
        return ZAI_FALLBACK_MODELS


def backend_for(model: str, routes: dict[str, str]) -> str:
    """'zai' or 'codex' for a requested model id. Exported for tests."""
    if model in routes:
        return routes[model]
    return "zai" if model.lower().startswith("glm") else "codex"


class Router:
    def __init__(self) -> None:
        self.zai = ZaiAdapter()
        self.routes: dict[str, str] = {}

    async def models(self, session) -> list[dict[str, str]]:
        data: list[dict] = []
        listed: set[str] = set()  # this listing only — routes persist across listings
        try:
            codex_rows = []
            for m in await asyncio.to_thread(codex.codex_model_ids):
                if m in listed:
                    continue
                listed.add(m)
                self.routes[m] = "codex"
                codex_rows.append({"id": m, "object": "model", "owned_by": "openai"})
            token, base_url = await asyncio.to_thread(codex.codex_credentials)
            data.extend(await codex.with_context_lengths(codex_rows, "openai-codex", base_url, token))
        except Exception as exc:
            logger.info("ChatGPT models unavailable: %s", exc)
        if self.zai.is_authenticated():
            ids: list[str] = []
            try:
                cred = self.zai.get_credential()
            except Exception as exc:
                logger.info("Z.AI key unusable: %s", exc)
                return data
            try:
                async with session.get(f"{cred.base_url}/models", headers={"Authorization": f"Bearer {cred.bearer}"}) as resp:
                    if resp.status == 200:
                        body = await resp.json(content_type=None)
                        ids = [str(m["id"]) for m in body.get("data", []) if isinstance(m, dict) and m.get("id")]
            except Exception as exc:
                logger.info("Z.AI model list unavailable, using Hermes' catalog: %s", exc)
            zai_rows = []
            for m in ids or zai_static_models():
                if m in listed:
                    continue
                listed.add(m)
                self.routes[m] = "zai"
                zai_rows.append({"id": m, "object": "model", "owned_by": "z.ai"})
            data.extend(await codex.with_context_lengths(zai_rows, "zai", cred.base_url, cred.bearer))
        return data

    async def zai_chat(self, request: web.Request, raw: bytes) -> web.StreamResponse:
        """Forward a Chat Completions request to Z.AI unchanged (stream preserved)."""
        session = request.app["session"]
        try:
            cred = self.zai.get_credential()
        except Exception as exc:
            return codex._error(401, str(exc))
        headers = {"Authorization": f"Bearer {cred.bearer}", "Content-Type": "application/json"}
        resp = await session.post(f"{cred.base_url}/chat/completions", data=raw, headers=headers)
        if resp.status == 429:
            retry = self.zai.get_retry_credential(failed_credential=cred, status_code=429)
            if retry is not None:
                resp.release()
                headers["Authorization"] = f"Bearer {retry.bearer}"
                resp = await session.post(f"{retry.base_url}/chat/completions", data=raw, headers=headers)
        async with resp:
            out = web.StreamResponse(status=resp.status, headers={
                "Content-Type": resp.headers.get("Content-Type", "application/json"),
                "Cache-Control": "no-cache",
            })
            await out.prepare(request)
            async for chunk in resp.content.iter_any():
                await out.write(chunk)
            await out.write_eof()
            return out


def build_app() -> web.Application:
    router = Router()

    async def handle_models(request: web.Request) -> web.StreamResponse:
        if (refused := codex._local_only(request)) is not None:
            return refused
        data = await router.models(request.app["session"])
        if not data:
            return codex._error(401, "Neither a ChatGPT login nor a Z.AI key is set up in Hermes.")
        return web.json_response({"object": "list", "data": data})

    async def handle_chat(request: web.Request) -> web.StreamResponse:
        if (refused := codex._local_only(request)) is not None:
            return refused
        raw = await request.read()
        try:
            body = json.loads(raw)
        except Exception:
            return codex._error(400, "Invalid JSON body")
        if not isinstance(body, dict) or not body.get("model"):
            return codex._error(400, "model is required")
        if backend_for(str(body["model"]), router.routes) == "zai":
            return await router.zai_chat(request, raw)
        return await codex.codex_chat(request, body)

    return codex.build_app(models_handler=handle_models, chat_handler=handle_chat)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes proxy for ChatGPT + Z.AI (for LearnHarness)")
    parser.add_argument("--host", default=codex.DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    codex.load_hermes_dotenv()
    have_codex = True
    try:
        codex.codex_credentials()
    except Exception:
        have_codex = False
    have_zai = ZaiAdapter().is_authenticated()
    if not (have_codex or have_zai):
        print("Neither a ChatGPT login nor a Z.AI key is set up in Hermes.", file=sys.stderr)
        return 1
    print(
        "Hermes proxy for LearnHarness\n"
        f"  Listening on: http://{args.host}:{args.port}/v1\n"
        f"  ChatGPT (Codex login): {'ready' if have_codex else 'not set up'}\n"
        f"  Z.AI (GLM key):        {'ready' if have_zai else 'not set up'}\n"
        "  In LearnHarness: Settings → Providers → Custom endpoint → this URL, Keyless.\n"
        "  Stop with Ctrl+C."
    )
    web.run_app(build_app(), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
