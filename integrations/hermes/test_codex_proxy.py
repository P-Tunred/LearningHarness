"""Tests for the Chat Completions ↔ Responses translation in codex_proxy.py.

Run with Hermes' Python (the module imports Hermes):
    ./run-with-hermes.sh test_codex_proxy.py
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import codex_proxy as cp  # noqa: E402

TOOLS = [{"type": "function", "function": {"name": "probe", "description": "ask", "parameters": {"type": "object"}}}]


class RequestTranslation(unittest.TestCase):
    def test_messages_tools_and_images(self):
        out = cp.chat_to_responses({
            "model": "gpt-5.5",
            "tools": TOOLS,
            "reasoning_effort": "low",
            "messages": [
                {"role": "system", "content": "Du bist Lehrer."},
                {"role": "user", "content": [
                    {"type": "text", "text": "Hi"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                ]},
                {"role": "assistant", "content": "Moment", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "probe", "arguments": "{\"q\":1}"}},
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "4"},
            ],
        })
        self.assertEqual(out["instructions"], "Du bist Lehrer.")
        self.assertEqual(out["store"], False)
        self.assertEqual(out["stream"], True)
        self.assertEqual(out["reasoning"], {"effort": "low"})
        self.assertEqual([i["type"] for i in out["input"]], ["message", "message", "function_call", "function_call_output"])
        self.assertEqual(out["input"][0]["content"][1], {"type": "input_image", "image_url": "data:image/png;base64,AAAA"})
        self.assertEqual(out["input"][1]["content"], [{"type": "output_text", "text": "Moment"}])
        self.assertEqual(out["input"][2], {"type": "function_call", "call_id": "call_1", "name": "probe", "arguments": "{\"q\":1}"})
        self.assertEqual(out["input"][3], {"type": "function_call_output", "call_id": "call_1", "output": "4"})
        self.assertEqual(out["tools"][0]["name"], "probe")
        self.assertEqual(out["tool_choice"], "auto")

    def test_no_tools_and_default_instructions(self):
        out = cp.chat_to_responses({"model": "gpt-5.5", "messages": [{"role": "user", "content": "x"}]})
        self.assertNotIn("tools", out)
        self.assertEqual(out["instructions"], cp.DEFAULT_INSTRUCTIONS)


class ResponseTranslation(unittest.TestCase):
    def events(self):
        return [
            {"type": "response.created"},
            {"type": "response.output_text.delta", "delta": "Hal"},
            {"type": "response.output_text.delta", "delta": "lo"},
            {"type": "response.output_item.added", "item": {"type": "function_call", "id": "fc_1", "call_id": "call_9", "name": "quiz", "arguments": ""}},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "{\"a\":"},
            {"type": "response.function_call_arguments.delta", "item_id": "fc_1", "delta": "1}"},
            {"type": "response.completed", "response": {"usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}}},
        ]

    def test_stream_chunks_and_collected_completion(self):
        t = cp.ChunkTranslator("gpt-5.5")
        chunks = [c for e in self.events() for c in t.feed(e)]
        self.assertEqual(chunks[0]["choices"][0]["delta"]["role"], "assistant")
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "tool_calls")
        self.assertEqual(chunks[-1]["usage"]["prompt_tokens"], 10)
        done = cp.collect_completion(chunks, "gpt-5.5")
        msg = done["choices"][0]["message"]
        self.assertEqual(msg["content"], "Hallo")
        self.assertEqual(msg["tool_calls"], [{"id": "call_9", "type": "function", "function": {"name": "quiz", "arguments": "{\"a\":1}"}}])
        json.dumps(done)  # serializable

    def test_failure_is_reported(self):
        t = cp.ChunkTranslator("gpt-5.5")
        t.feed({"type": "response.failed", "response": {"error": {"message": "usage limit"}}})
        self.assertEqual(t.error, "usage limit")
        self.assertTrue(t.finished)


if __name__ == "__main__":
    unittest.main()
