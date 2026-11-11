#!/usr/bin/env node
// Fork addition (Paul, 2026-11-11): "some of my questions are not
// answered" — every text he sent (message, thinking, thinking while
// reading, free answer) next to what the tutor wrote back before its next
// move. Dictated speech often has no "?", so every text is listed; "?"
// marks the ones with a question mark. Read-only; terminal only.
//
//   node scripts/my-questions.mjs "Clustering"        last 10 texts
//   node scripts/my-questions.mjs "Clustering" 25
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(repo, "data"), "chats");
const filter = process.argv[2] && Number.isNaN(Number(process.argv[2])) ? process.argv[2].toLowerCase() : null;
const count = Math.max(1, Number(filter ? process.argv[3] : process.argv[2]) || 10);

const files = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
	.sort((a, b) => b.t - a.t);
let chat = null;
for (const { f } of files) {
	try {
		const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		if (!filter || String(c.title ?? "").toLowerCase().includes(filter)) { chat = c; break; }
	} catch { /* skip */ }
}
if (!chat) { console.error("No matching chat"); process.exit(1); }

const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const time = (ms) => (typeof ms === "number" ? new Date(ms).toLocaleString() : "");
const textOf = (content) => (Array.isArray(content) ? content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ") : String(content ?? ""));

// His texts, in order, each with the index where the tutor's reply starts.
const msgs = chat.messages ?? [];
const inputs = [];
msgs.forEach((m, i) => {
	if (!m || typeof m !== "object") return;
	const texts = [];
	if (m.role === "user") texts.push(["message", textOf(m.content)]);
	// Of the custom messages only his practice thinking is his; the rest
	// are system notes (agent results, compaction, plan blocks).
	else if (m.role === "custom" && m.customType === "practice-thinking") texts.push(["thinking", m.details?.text ?? textOf(m.content)]);
	else if (m.role === "toolResult" && m.details && typeof m.details.questionText === "string") {
		const d = m.details;
		if (d.text) texts.push(["free answer", d.text]);
		if (d.other) texts.push(["other", d.other]);
		if (d.thinking ?? d.note) texts.push(["thinking", d.thinking ?? d.note]);
		if (d.readingThinking) texts.push(["thinking while reading", d.readingThinking]);
	}
	for (const [channel, t] of texts) {
		const text = flat(t);
		if (text && !text.startsWith("[")) inputs.push({ i, channel, text, at: m.timestamp ?? (m.details?.answeredAt ? Date.parse(m.details.answeredAt) : undefined) });
	}
});

console.log(`=== ${chat.title} — your last ${Math.min(count, inputs.length)} texts and the tutor's reply`);
for (const inp of inputs.slice(-count)) {
	// The tutor's reply: its assistant text until his next input.
	const parts = [];
	const moves = [];
	for (let j = inp.i + 1; j < msgs.length; j++) {
		const m = msgs[j];
		if (!m) continue;
		const isInput = m.role === "user" || (m.role === "custom" && m.customType === "practice-thinking") || (m.role === "toolResult" && m.details && typeof m.details.questionText === "string");
		if (isInput) break;
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const c of m.content) {
			if (c?.type === "text" && flat(c.text)) parts.push(flat(c.text));
			if (c?.type === "toolCall") moves.push(c.name);
		}
	}
	const reply = parts.join(" ");
	console.log(`\n${time(inp.at)}  YOU (${inp.channel})${inp.text.includes("?") ? "  ?" : ""}`);
	console.log(`  ${cut(inp.text, 400)}`);
	console.log(reply ? `  TUTOR: ${cut(reply, 400)}` : `  TUTOR: (no text${moves.length ? ` — went straight to: ${moves.join(", ")}` : ""})`);
}
