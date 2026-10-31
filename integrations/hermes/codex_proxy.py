"""Hermes proxy for the ChatGPT subscription (OpenAI Codex login): LearnHarness → Hermes → ChatGPT.

LearnHarness' custom endpoint speaks OpenAI *Chat Completions*. Hermes reaches
the ChatGPT subscription through the Codex backend
(``chatgpt.com/backend-api/codex``), which speaks the *Responses* API. This
proxy translates between the two and uses Hermes' own Codex login — token
storage and refresh, the account headers and Hermes' client identity — so
Hermes stays unmodified and no key is stored in LearnHarness.

    Chat Completions request  →  Responses request  (messages, tools, images)
    Responses SSE events      →  chat.completion.chunk SSE (text, tool calls, usage)

Run it with the Python of your Hermes installation (``start-codex-proxy.sh``)
after logging in once with ``hermes auth add openai-codex`` / ``hermes setup``.
Then in LearnHarness: Settings → Providers → Custom endpoint →
``http://127.0.0.1:8646/v1`` (Keyless). Binds 127.0.0.1 only.

The Codex backend is OpenAI's endpoint for Codex clients, not a public API;
if OpenAI changes it, this proxy can stop working until it is updated.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
import uuid
from typing import Any, AsyncIterator, Optional

try:
    import aiohttp
    from aiohttp import web
except ImportError:  # pragma: no cover - depends on the user's install
    sys.exit("Hermes' proxy needs aiohttp. Run `hermes setup` (or install aiohttp into Hermes' Python).")

try:
    from agent.codex_headers import codex_cloudflare_headers
    from hermes_cli.auth_codex import resolve_codex_runtime_credentials
    from hermes_cli.codex_models import get_codex_model_ids
    from hermes_cli.env_loader import load_hermes_dotenv
except ImportError as exc:  # pragma: no cover - depends on the user's install
    sys.exit(
        "Hermes Agent was not found in this Python environment "
        f"({exc}). Start this file with Hermes' own Python, e.g. via start-codex-proxy.sh."
    )

try:  # ``-900k`` picker variants are Hermes-side aliases; the backend knows only the base slug.
    from agent.model_metadata import strip_codex_context_variant_suffix as wire_model
except ImportError:  # pragma: no cover - older Hermes
    def wire_model(model: Optional[str]) -> str:
        return (model or "").strip()

logger = logging.getLogger("learnharness.codex_proxy")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8646
MAX_REQUEST_BYTES = 10_000_000
DEFAULT_INSTRUCTIONS = "You are a helpful assistant."


# ─── Credentials ─────────────────────────────────────────────────────────────

def codex_credentials(force_refresh: bool = False) -> tuple[str, str]:
    """(access_token, base_url) from Hermes' Codex token store; refreshed when expiring."""
    creds = resolve_codex_runtime_credentials(force_refresh=force_refresh)
    token = str(creds.get("api_key") or "").strip()
    base_url = str(creds.get("base_url") or "").strip().rstrip("/")
    if not token or not base_url:
        raise RuntimeError("No ChatGPT/Codex login in Hermes. Run `hermes auth add openai-codex` (or `hermes setup`).")
    return token, base_url


def upstream_headers(token: str, base_url: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        **codex_cloudflare_headers(token, base_url=base_url),
    }


# ─── Request translation: Chat Completions → Responses ───────────────────────

def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") == "text"
        )
    return "" if content is None else str(content)


def _user_parts(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "input_text", "text": content}]
    parts: list[dict[str, Any]] = []
    for p in content if isinstance(content, list) else []:
        if not isinstance(p, dict):
            continue
        if p.get("type") == "text":
            parts.append({"type": "input_text", "text": str(p.get("text", ""))})
        elif p.get("type") == "image_url":
            url = p.get("image_url")
            url = url.get("url") if isinstance(url, dict) else url
            if isinstance(url, str) and url:
                parts.append({"type": "input_image", "image_url": url})
    return parts or [{"type": "input_text", "text": ""}]


def chat_to_responses(body: dict[str, Any]) -> dict[str, Any]:
    """Translate a Chat Completions request body into a Codex Responses body."""
    instructions: list[str] = []
    items: list[dict[str, Any]] = []
    for msg in body.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role in ("system", "developer"):
            text = _text_of(msg.get("content"))
            if text:
                instructions.append(text)
        elif role == "user":
            items.append({"type": "message", "role": "user", "content": _user_parts(msg.get("content"))})
        elif role == "assistant":
            text = _text_of(msg.get("content"))
            if text:
                items.append({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]})
            for call in msg.get("tool_calls") or []:
                fn = call.get("function") or {}
                args = fn.get("arguments")
                items.append({
                    "type": "function_call",
                    "call_id": str(call.get("id") or f"call_{uuid.uuid4().hex[:12]}"),
                    "name": str(fn.get("name") or ""),
                    "arguments": args if isinstance(args, str) else json.dumps(args or {}),
                })
        elif role == "tool":
            items.append({
                "type": "function_call_output",
                "call_id": str(msg.get("tool_call_id") or ""),
                "output": _text_of(msg.get("content")),
            })
    out: dict[str, Any] = {
        "model": wire_model(str(body.get("model") or "")),
        "instructions": "\n\n".join(instructions) or DEFAULT_INSTRUCTIONS,
        "input": items,
        "store": False,
        "stream": True,
    }
    tools = []
    for tool in body.get("tools") or []:
        fn = tool.get("function") if isinstance(tool, dict) and tool.get("type") == "function" else None
        if not fn:
            continue
        tools.append({
            "type": "function",
            "name": fn.get("name"),
            "description": fn.get("description") or "",
            "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
            "strict": fn.get("strict") if isinstance(fn.get("strict"), bool) else False,
        })
    if tools:
        out["tools"] = tools
        choice = body.get("tool_choice")
        out["tool_choice"] = choice if choice in ("auto", "none", "required") else "auto"
        out["parallel_tool_calls"] = body.get("parallel_tool_calls", True) is not False
    effort = body.get("reasoning_effort")
    if isinstance(effort, str) and effort:
        out["reasoning"] = {"effort": effort}
    return out


# ─── Response translation: Responses SSE → Chat Completions chunks ───────────

class ChunkTranslator:
    """Feeds Responses events, yields chat.completion.chunk dicts."""

    def __init__(self, model: str) -> None:
        self.id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        self.model = model
        self.created = int(time.time())
        self.role_sent = False
        self.tool_index: dict[str, int] = {}  # Responses item id → chat tool_call index
        self.saw_tool_call = False
        self.finished = False
        self.error: Optional[str] = None

    def _chunk(self, delta: dict[str, Any], finish: Optional[str] = None, usage: Optional[dict] = None) -> dict[str, Any]:
        if not self.role_sent:
            delta = {"role": "assistant", **delta}
            self.role_sent = True
        chunk: dict[str, Any] = {
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }
        if usage is not None:
            chunk["usage"] = usage
        return chunk

    def feed(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        kind = event.get("type")
        if kind == "response.output_text.delta":
            return [self._chunk({"content": str(event.get("delta", ""))})]
        if kind == "response.reasoning_summary_text.delta":
            return [self._chunk({"reasoning_content": str(event.get("delta", ""))})]
        if kind == "response.output_item.added":
            item = event.get("item") or {}
            if item.get("type") == "function_call":
                index = len(self.tool_index)
                self.tool_index[str(item.get("id"))] = index
                self.saw_tool_call = True
                return [self._chunk({"tool_calls": [{
                    "index": index,
                    "id": item.get("call_id"),
                    "type": "function",
                    "function": {"name": item.get("name"), "arguments": item.get("arguments") or ""},
                }]})]
            return []
        if kind == "response.function_call_arguments.delta":
            index = self.tool_index.get(str(event.get("item_id")))
            if index is None:
                return []
            return [self._chunk({"tool_calls": [{"index": index, "function": {"arguments": str(event.get("delta", ""))}}]})]
        if kind in ("response.completed", "response.incomplete"):
            response = event.get("response") or {}
            usage = response.get("usage") or {}
            cached = (usage.get("input_tokens_details") or {}).get("cached_tokens", 0)
            chat_usage = {
                "prompt_tokens": usage.get("input_tokens", 0),
                "completion_tokens": usage.get("output_tokens", 0),
                "total_tokens": usage.get("total_tokens", usage.get("input_tokens", 0) + usage.get("output_tokens", 0)),
                "prompt_tokens_details": {"cached_tokens": cached},
            }
            if kind == "response.incomplete":
                finish = "length"
            else:
                finish = "tool_calls" if self.saw_tool_call else "stop"
            self.finished = True
            return [self._chunk({}, finish=finish, usage=chat_usage)]
        if kind in ("response.failed", "error"):
            err = (event.get("response") or {}).get("error") or event.get("error") or event
            self.error = str(err.get("message") if isinstance(err, dict) else err)
            self.finished = True
        return []


async def iter_sse(resp: aiohttp.ClientResponse) -> AsyncIterator[dict[str, Any]]:
    """Parse an SSE stream into JSON event objects."""
    buffer = b""
    async for chunk in resp.content.iter_any():
        buffer += chunk
        while b"\n\n" in buffer:
            raw, buffer = buffer.split(b"\n\n", 1)
            data = "\n".join(
                line[5:].lstrip() for line in raw.decode("utf-8", "replace").splitlines() if line.startswith("data:")
            )
            if not data or data == "[DONE]":
                continue
            try:
                yield json.loads(data)
            except json.JSONDecodeError:
                continue


def collect_completion(chunks: list[dict[str, Any]], model: str) -> dict[str, Any]:
    """Fold translated chunks into one non-streaming chat.completion."""
    content = ""
    calls: dict[int, dict[str, Any]] = {}
    finish = "stop"
    usage: dict[str, Any] = {}
    for chunk in chunks:
        choice = chunk["choices"][0]
        delta = choice["delta"]
        content += delta.get("content") or ""
        for tc in delta.get("tool_calls") or []:
            slot = calls.setdefault(tc["index"], {"id": None, "type": "function", "function": {"name": "", "arguments": ""}})
            if tc.get("id"):
                slot["id"] = tc["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                slot["function"]["name"] = fn["name"]
            slot["function"]["arguments"] += fn.get("arguments") or ""
        if choice.get("finish_reason"):
            finish = choice["finish_reason"]
        if chunk.get("usage"):
            usage = chunk["usage"]
    message: dict[str, Any] = {"role": "assistant", "content": content or None}
    if calls:
        message["tool_calls"] = [calls[i] for i in sorted(calls)]
    return {
        "id": chunks[0]["id"] if chunks else f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": usage,
    }


# ─── HTTP server ─────────────────────────────────────────────────────────────

def _error(status: int, message: str) -> web.Response:
    return web.json_response({"error": {"message": message, "type": "proxy_error", "code": "proxy_error"}}, status=status)


def _local_only(request: web.Request) -> Optional[web.Response]:
    # Same browser guard as Hermes' own proxy: refuse requests a web page made.
    origin = request.headers.get("Origin")
    site = request.headers.get("Sec-Fetch-Site")
    if (origin and origin != "null") or site in ("cross-site", "same-site"):
        return _error(403, "Browser requests are not accepted.")
    return None


async def handle_models(request: web.Request) -> web.StreamResponse:
    if (refused := _local_only(request)) is not None:
        return refused
    try:
        token, base_url = await asyncio.to_thread(codex_credentials)
        ids = await asyncio.to_thread(get_codex_model_ids, token, base_url)
    except Exception as exc:
        return _error(401, str(exc))
    return web.json_response({"object": "list", "data": [{"id": m, "object": "model", "owned_by": "openai"} for m in ids]})


async def _open_upstream(session: aiohttp.ClientSession, payload: dict[str, Any]) -> aiohttp.ClientResponse:
    token, base_url = await asyncio.to_thread(codex_credentials)
    resp = await session.post(f"{base_url}/responses", json=payload, headers=upstream_headers(token, base_url))
    if resp.status == 401:
        resp.release()
        token, base_url = await asyncio.to_thread(codex_credentials, True)
        resp = await session.post(f"{base_url}/responses", json=payload, headers=upstream_headers(token, base_url))
    return resp


async def handle_chat(request: web.Request) -> web.StreamResponse:
    if (refused := _local_only(request)) is not None:
        return refused
    try:
        body = await request.json()
    except Exception:
        return _error(400, "Invalid JSON body")
    if not isinstance(body, dict) or not body.get("model"):
        return _error(400, "model is required")
    payload = chat_to_responses(body)
    model = str(body["model"])
    stream = body.get("stream") is True
    session: aiohttp.ClientSession = request.app["session"]
    try:
        upstream = await _open_upstream(session, payload)
    except Exception as exc:
        return _error(401 if "login" in str(exc).lower() else 502, str(exc))
    async with upstream:
        if upstream.status != 200:
            detail = (await upstream.text())[:2000]
            return _error(upstream.status, f"ChatGPT backend returned HTTP {upstream.status}: {detail}")
        translator = ChunkTranslator(model)
        if not stream:
            chunks: list[dict[str, Any]] = []
            async for event in iter_sse(upstream):
                chunks.extend(translator.feed(event))
            if translator.error:
                return _error(502, translator.error)
            return web.json_response(collect_completion(chunks, model))
        out = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"})
        await out.prepare(request)
        async for event in iter_sse(upstream):
            for chunk in translator.feed(event):
                await out.write(f"data: {json.dumps(chunk)}\n\n".encode())
            if translator.error:
                err = {"error": {"message": translator.error, "type": "upstream_error"}}
                await out.write(f"data: {json.dumps(err)}\n\n".encode())
                break
        await out.write(b"data: [DONE]\n\n")
        await out.write_eof()
        return out


def build_app() -> web.Application:
    app = web.Application(client_max_size=MAX_REQUEST_BYTES)

    async def session_ctx(app: web.Application):
        app["session"] = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_read=600))
        yield
        await app["session"].close()

    app.cleanup_ctx.append(session_ctx)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_post("/v1/chat/completions", handle_chat)
    return app


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Hermes proxy for the ChatGPT subscription (for LearnHarness)")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    load_hermes_dotenv()
    try:
        _, base_url = codex_credentials()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(
        "Hermes proxy for ChatGPT (Codex login)\n"
        f"  Listening on:  http://{args.host}:{args.port}/v1\n"
        f"  Forwarding to: {base_url}/responses\n"
        "  In LearnHarness: Settings → Providers → Custom endpoint → this URL, Keyless.\n"
        "  Stop with Ctrl+C."
    )
    web.run_app(build_app(), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
