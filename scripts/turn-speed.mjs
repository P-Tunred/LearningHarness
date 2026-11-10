#!/usr/bin/env node
// Fork addition (Paul, 2026-11-10): "thinking suddenly takes longer" — what
// changed between days? Per day, for one chat (title contains the text) or
// the newest chat: how many tutor replies, how many MODEL ROUNDS each
// needed (every tool call before the question is one more full round:
// the whole chat is read again and thought about again), which extra
// tools were called, how many tokens it read / took from the cache /
// wrote / spent thinking. Read-only; prints to the terminal only.
//
//   node scripts/turn-speed.mjs "Dimensionality"
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(repo, "data"), "chats");
const filter = process.argv[2]?.toLowerCase() ?? null;
const QUESTION_TOOLS = new Set(["quiz", "explain", "ask_user_question", "probe", "recall", "problem"]);

const chats = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
	.sort((a, b) => b.t - a.t);
let chat = null;
for (const { f } of chats) {
	try {
		const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		if (!filter || String(c.title ?? "").toLowerCase().includes(filter)) { chat = c; break; }
	} catch { /* skip */ }
}
if (!chat) { console.error("No matching chat"); process.exit(1); }

const day = (ms) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// A reply = the tutor's assistant messages between two inputs of his.
const replies = [];
let current = null;
for (const m of chat.messages ?? []) {
	if (!m || typeof m !== "object") continue;
	const isInput = m.role === "user" || m.role === "custom" || (m.role === "toolResult" && m.details && typeof m.details.questionText === "string");
	if (isInput) { current = null; continue; }
	if (m.role !== "assistant") continue;
	if (!current) { current = { day: day(m.timestamp ?? 0), rounds: [] }; replies.push(current); }
	current.rounds.push(m);
}

const byDay = new Map();
for (const r of replies) {
	const s = byDay.get(r.day) ?? { replies: 0, rounds: 0, extra: new Map(), input: 0, cache: 0, output: 0, reasoning: 0, reasoningSeen: false, durMs: 0, durN: 0, models: new Set(), levels: new Set(), stops: new Map() };
	s.replies++;
	s.rounds += r.rounds.length;
	for (const m of r.rounds) {
		const u = m.usage ?? {};
		s.input += (u.input ?? 0) + (u.cacheRead ?? 0);
		s.cache += u.cacheRead ?? 0;
		s.output += u.output ?? 0;
		if (typeof u.reasoning === "number") { s.reasoning += u.reasoning; s.reasoningSeen = true; }
		if (typeof m.duration === "number") { s.durMs += m.duration; s.durN++; }
		if (m.model) s.models.add(m.model);
		if (m.thinkingLevel || m.providerThinkingLevel) s.levels.add(m.providerThinkingLevel ?? m.thinkingLevel);
		s.stops.set(m.stopReason ?? "?", (s.stops.get(m.stopReason ?? "?") ?? 0) + 1);
		for (const c of Array.isArray(m.content) ? m.content : []) {
			if (c?.type === "toolCall" && !QUESTION_TOOLS.has(c.name)) s.extra.set(c.name, (s.extra.get(c.name) ?? 0) + 1);
		}
	}
	byDay.set(r.day, s);
}

console.log(`=== ${chat.title}`);
for (const [d, s] of [...byDay].sort((a, b) => a[0].localeCompare(b[0])).slice(-5)) {
	const per = (n) => Math.round(n / Math.max(1, s.rounds));
	const extra = [...s.extra].map(([k, v]) => `${k}×${v}`).join(", ") || "none";
	console.log(`\n${d}: ${s.replies} replies, ${(s.rounds / Math.max(1, s.replies)).toFixed(2)} model rounds per reply`);
	console.log(`  extra tool calls: ${extra}`);
	console.log(`  per round: reads ${per(s.input)} tokens (${s.input ? Math.round((100 * s.cache) / s.input) : 0} % from cache), writes ${per(s.output)}${s.reasoningSeen ? `, of which thinking ${per(s.reasoning)}` : ""}`);
	if (s.durN) console.log(`  average round time: ${(s.durMs / s.durN / 1000).toFixed(1)} s`);
	console.log(`  model: ${[...s.models].join(", ")}${s.levels.size ? ` · thinking level: ${[...s.levels].join(", ")}` : ""} · endings: ${[...s.stops].map(([k, v]) => `${k}×${v}`).join(", ")}`);
}
