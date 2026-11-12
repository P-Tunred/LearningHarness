#!/usr/bin/env node
// Fork addition (Paul, 2026-11-12): which chats sit in a sidebar folder
// (e.g. "INTSEC"), and which of them are lecture sessions from
// LearnHarness/Auftraege/<Fach> Vorlesungen.md? Read-only: it deletes
// nothing — delete in the app (right-click a chat → Delete).
//
//   node scripts/folder-chats.mjs "INTSEC"
// Matches every folder whose name contains the text (case ignored),
// subfolders included.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(repo, "data");
const want = (process.argv[2] ?? "").toLowerCase();
if (!want) {
	console.error('usage: node scripts/folder-chats.mjs "<folder name>"');
	process.exit(2);
}
const readJson = (file, fallback) => {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

const org = readJson(path.join(data, "graph", "source-organization.json"), { folders: [], placements: {} });
const folders = org.folders ?? [];
const byId = new Map(folders.map((f) => [f.id, f]));
// A folder matches when it, or any folder above it, contains the text.
const pathOf = (id) => {
	const names = [];
	const seen = new Set();
	for (let f = byId.get(id); f && !seen.has(f.id); f = byId.get(f.parentId)) { seen.add(f.id); names.unshift(f.name); }
	return names;
};
const matching = new Set(folders.filter((f) => pathOf(f.id).some((n) => String(n).toLowerCase().includes(want))).map((f) => f.id));

// Lecture sessions: the exam plans' bookkeeping, plans named "… Vorlesungen.md".
const exams = readJson(path.join(data, "klausur-auftraege.json"), { plans: {} });
const lecture = new Map();
for (const [file, plan] of Object.entries(exams.plans ?? {})) {
	for (const s of Object.values(plan.sessions ?? {})) lecture.set(s.chatId, /vorlesungen\.md$/i.test(file) ? "lecture session" : `exam plan "${file}"`);
}

const rows = [];
for (const [chatId, placement] of Object.entries(org.placements ?? {})) {
	if (!placement?.folderId || !matching.has(placement.folderId)) continue;
	const chat = readJson(path.join(data, "chats", `${chatId}.json`), null);
	if (!chat) continue;
	rows.push({
		chatId,
		title: chat.title ?? chatId,
		folder: pathOf(placement.folderId).join(" / "),
		kind: lecture.get(chatId) ?? "OTHER",
		messages: (chat.messages ?? []).length,
		updated: chat.updatedAt ?? "",
	});
}
if (rows.length === 0) {
	console.log(`No chats in a folder matching "${process.argv[2]}". Folders: ${folders.map((f) => f.name).join(", ") || "none"}`);
	process.exit(0);
}
rows.sort((a, b) => (a.kind === "OTHER" ? 0 : 1) - (b.kind === "OTHER" ? 0 : 1) || a.title.localeCompare(b.title, undefined, { numeric: true }));
const others = rows.filter((r) => r.kind === "OTHER");
console.log(`${rows.length} chats in "${process.argv[2]}" — ${others.length} not from a plan (candidates to delete), ${rows.length - others.length} from plans (keep)\n`);
for (const r of rows) {
	console.log(`${r.kind === "OTHER" ? "DELETE?" : "keep   "}  ${r.title}  [${r.folder}] · ${r.messages} messages · last ${String(r.updated).slice(0, 10)} · ${r.kind}`);
}
