#!/usr/bin/env node
// Fork addition (Paul, 2026-11-10): "the tutor just stopped" — how did its
// last replies end? Lists the last messages of the most recently changed
// chat (or the chat whose title contains the given text) with the model,
// the stop reason and any error. Read-only; prints to the terminal only.
//
//   node scripts/last-turns.mjs                 newest chat, last 12 messages
//   node scripts/last-turns.mjs "Dimensionality" 20
// Stop reasons: stop = finished normally · toolUse = called a tool (a
// question ends the reply on purpose) · length = CUT OFF at the output
// limit · error = the model/provider failed · aborted = stopped (Esc,
// quit, network).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(repo, "data"), "chats");
const filter = process.argv[2] && Number.isNaN(Number(process.argv[2])) ? process.argv[2].toLowerCase() : null;
const count = Math.max(1, Number(filter ? process.argv[3] : process.argv[2]) || 12);

if (!fs.existsSync(dir)) {
	console.error(`No chats folder at ${dir}`);
	process.exit(1);
}
const chats = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
	.sort((a, b) => b.t - a.t);

let chat = null;
for (const { f } of chats) {
	try {
		const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		if (!filter || String(c.title ?? "").toLowerCase().includes(filter)) {
			chat = c;
			break;
		}
	} catch {
		/* unreadable file: skip */
	}
}
if (!chat) {
	console.error(filter ? `No chat whose title contains "${filter}"` : "No chats");
	process.exit(1);
}

const one = (s, n = 140) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};
const when = (ms) => (typeof ms === "number" ? new Date(ms).toLocaleTimeString() : "        ");

console.log(`=== ${chat.title} — last ${count} of ${chat.messages?.length ?? 0} messages`);
for (const m of (chat.messages ?? []).slice(-count)) {
	if (!m || typeof m !== "object") continue;
	if (m.role === "user") {
		const text = Array.isArray(m.content) ? m.content.map((c) => c?.text ?? "").join(" ") : m.content;
		console.log(`${when(m.timestamp)}  YOU        ${one(text)}`);
	} else if (m.role === "assistant") {
		const parts = Array.isArray(m.content) ? m.content : [];
		const text = parts.filter((c) => c?.type === "text").map((c) => c.text).join(" ");
		const tools = parts.filter((c) => c?.type === "toolCall").map((c) => c.name).join(", ");
		const secs = typeof m.duration === "number" ? ` ${Math.round(m.duration / 1000)}s` : "";
		const out = m.usage && typeof m.usage.output === "number" ? ` out=${m.usage.output}` : "";
		console.log(`${when(m.timestamp)}  TUTOR      [${m.stopReason ?? "?"}${secs}${out}] ${m.model ?? ""}${tools ? `  tools: ${tools}` : ""}`);
		if (text) console.log(`                      ${one(text)}`);
		if (m.errorMessage) console.log(`                      ERROR: ${one(m.errorMessage, 400)}`);
	} else if (m.role === "toolResult") {
		const answer = m.details && typeof m.details.questionText === "string"
			? (m.details.dontKnow ? "don't know" : typeof m.details.correct === "boolean" ? (m.details.correct ? "right" : "wrong") : "answered")
			: null;
		const text = Array.isArray(m.content) ? m.content.map((c) => c?.text ?? "").join(" ") : "";
		console.log(`${when(m.timestamp)}  ${m.isError ? "TOOL ERROR" : "tool      "} ${m.toolName ?? "?"}${answer ? ` → your answer: ${answer}` : ""}${m.isError ? `: ${one(text)}` : ""}`);
	} else {
		console.log(`${when(m.timestamp)}  ${String(m.role ?? m.type ?? "?").padEnd(10)} ${one(m.content ?? m.text ?? "")}`);
	}
}
