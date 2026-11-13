#!/usr/bin/env node
// Fork addition (Paul, 2026-11-13): keep a subject's sidebar folder to the
// lecture sessions plus chosen keepers; move every other chat into an
// archive folder. Nothing is deleted. Without --apply it only shows the
// plan. With --apply it talks to the running LearnHarness window
// (http://localhost:3000, the Dock icon's dev mode), so the sidebar
// updates at once.
//
//   node scripts/tidy-exam-folder.mjs --folder INTSEC --keep "Full past-exam training" --archive "INTSEC Archiv"
//   node scripts/tidy-exam-folder.mjs --folder INTSEC --keep "Full past-exam training" --archive "INTSEC Archiv" --apply
//
// Kept: lecture sessions (from LearnHarness/Auftraege/<Fach> Vorlesungen.md)
// and chats whose title contains a --keep text (repeatable). Folders match
// when their name contains the --folder text (case ignored); the archive
// folder itself never matches.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const all = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const folderText = (opt("--folder") ?? "").toLowerCase();
const archiveName = opt("--archive") ?? "";
const keepTexts = all("--keep").map((k) => k.toLowerCase());
const apply = args.includes("--apply");
const base = opt("--url") ?? "http://localhost:3000";
if (!folderText || !archiveName) {
	console.error('usage: node scripts/tidy-exam-folder.mjs --folder INTSEC --archive "INTSEC Archiv" [--keep "<title text>"]... [--apply]');
	process.exit(2);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(repo, "data");
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };

// Lecture sessions: the exam plans' bookkeeping for "… Vorlesungen.md".
const exams = readJson(path.join(data, "klausur-auftraege.json"), { plans: {} });
const lectureIds = new Set();
for (const [file, plan] of Object.entries(exams.plans ?? {})) {
	if (/vorlesungen\.md$/i.test(file) && !plan.retired) for (const s of Object.values(plan.sessions ?? {})) lectureIds.add(s.chatId);
}

async function api(method, body) {
	const res = await fetch(`${base}/api/graph/sources`, {
		method,
		headers: { "content-type": "application/json" },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${method} ${res.status}: ${json.error ?? "failed"}`);
	return json;
}

// The live organization when the app runs, else the file (dry run only).
let directory;
try {
	directory = await api("GET");
} catch (err) {
	if (apply) {
		console.error(`LearnHarness is not reachable at ${base} — open it with the Dock icon, then run again. (${err.message})`);
		process.exit(1);
	}
	directory = { organization: readJson(path.join(data, "graph", "source-organization.json"), { folders: [], placements: {} }) };
}
const org = directory.organization ?? { folders: [], placements: {} };
const folders = org.folders ?? [];
const byId = new Map(folders.map((f) => [f.id, f]));
const pathOf = (id) => {
	const names = [];
	const seen = new Set();
	for (let f = byId.get(id); f && !seen.has(f.id); f = byId.get(f.parentId)) { seen.add(f.id); names.unshift(f.name); }
	return names;
};
const archive = folders.find((f) => !f.parentId && f.name === archiveName);
const inArchive = (id) => {
	const seen = new Set();
	for (let f = byId.get(id); f && !seen.has(f.id); f = byId.get(f.parentId)) { seen.add(f.id); if (archive && f.id === archive.id) return true; }
	return false;
};
const matching = new Set(folders.filter((f) => !inArchive(f.id) && pathOf(f.id).some((n) => String(n).toLowerCase().includes(folderText))).map((f) => f.id));

const keep = [];
const move = [];
for (const [chatId, placement] of Object.entries(org.placements ?? {})) {
	if (!placement?.folderId || !matching.has(placement.folderId)) continue;
	const chat = readJson(path.join(data, "chats", `${chatId}.json`), null);
	if (!chat) continue;
	const title = String(chat.title ?? chatId);
	const why = lectureIds.has(chatId) ? "lecture session" : keepTexts.find((k) => title.toLowerCase().includes(k)) ? "kept by --keep" : null;
	(why ? keep : move).push({ chatId, title, folder: pathOf(placement.folderId).join(" / "), why });
}

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true });
console.log(`Folders matching "${opt("--folder")}": ${[...matching].map((id) => pathOf(id).join(" / ")).join(", ") || "none"}`);
console.log(`\nSTAYS (${keep.length}):`);
for (const r of keep.sort(byTitle)) console.log(`  ${r.title}  [${r.folder}] — ${r.why}`);
console.log(`\nMOVES to "${archiveName}" (${move.length}):`);
for (const r of move.sort(byTitle)) console.log(`  ${r.title}  [${r.folder}]`);

if (lectureIds.size === 0) {
	console.log("\nNo lecture sessions exist yet (no …Vorlesungen.md plan was read). Restart LearnHarness so the subject review creates them, then run this again.");
	if (apply) process.exit(1);
}
if (!apply) {
	console.log("\nNothing changed. Add --apply to move them (nothing is deleted).");
	process.exit(0);
}
let archiveId = archive?.id;
if (!archiveId) {
	archiveId = (await api("POST", { action: "create-folder", name: archiveName, parentId: null })).createdFolderId;
	console.log(`\nCreated folder "${archiveName}".`);
}
let moved = 0;
for (const r of move) {
	try {
		await api("POST", { action: "move", kind: "source", id: r.chatId, parentId: archiveId });
		moved++;
	} catch (err) {
		console.error(`  could not move "${r.title}": ${err.message}`);
	}
}
console.log(`\nMoved ${moved} of ${move.length} chats to "${archiveName}". Nothing was deleted.`);
