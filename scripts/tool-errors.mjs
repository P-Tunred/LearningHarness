#!/usr/bin/env node
// Fork addition (Paul, 2026-11-09): why did a chat show "Retrying…"?
// That line appears when the tutor called a tool with input the app
// rejected; the reason is stored in the chat as an error tool result.
// This lists those reasons for the most recently changed chats. Read-only;
// prints to the terminal only.
//
//   node scripts/tool-errors.mjs          last 3 chats
//   node scripts/tool-errors.mjs 10       last 10 chats
// Data folder: LH_DATA_DIR, else the repo's data/ (where the Dock icon's
// dev-mode app keeps it).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(repo, "data"), "chats");
const count = Math.max(1, Number(process.argv[2]) || 3);

if (!fs.existsSync(dir)) {
	console.error(`No chats folder at ${dir}`);
	process.exit(1);
}
const files = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
	.sort((a, b) => b.t - a.t)
	.slice(0, count);

const textOf = (content) =>
	Array.isArray(content) ? content.map((c) => (c && c.type === "text" ? c.text : "")).join(" ") : String(content ?? "");

for (const { f } of files) {
	let chat;
	try {
		chat = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
	} catch {
		continue;
	}
	const errors = (chat.messages ?? []).filter((m) => m && m.role === "toolResult" && m.isError === true);
	console.log(`\n=== ${chat.title ?? f} — ${errors.length} tool error(s)`);
	for (const m of errors.slice(-15)) {
		const when = typeof m.timestamp === "number" ? new Date(m.timestamp).toLocaleString() : "";
		const text = textOf(m.content).replace(/\s+/g, " ").trim();
		console.log(`- ${when}  ${m.toolName ?? "?"}: ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`);
	}
}
