/**
 * Klausur-Aufträge (fork addition) — the IO half against real files: a temp
 * copy of the golden data dir and a temp brain. A plan in
 * LearnHarness/Auftraege/ must become one session per focus inside the
 * exam's folder, never twice, and show up in the exported stats.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { localDay } from "../src/core/brain-export.ts";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-data");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-data-"));
fs.cpSync(GOLDEN, DATA, { recursive: true });
process.env.LH_DATA_DIR = DATA;
const BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-brain-"));
fs.mkdirSync(path.join(BRAIN, "wiki"), { recursive: true });
const PLANS = path.join(BRAIN, "LearnHarness", "Auftraege");
fs.mkdirSync(PLANS, { recursive: true });
const PLAN_FILE = path.join(PLANS, "fods.md");
const writePlan = (focuses: string[]) => fs.writeFileSync(PLAN_FILE, [
	"---", "klausur: FODS", "datum: 2026-11-20", "---",
	...focuses.flatMap((f) => [`## ${f}`, "Gewicht: hoch", `Ziel: ${f} sicher können.`, ""]),
].join("\n"));

const { stores } = await import("../src/server/stores.ts");
const { syncExamPlans, examOpeningPrompt, examOverviews } = await import("../src/server/exam-plans.ts");
const { exportToBrain } = await import("../src/server/brain.ts");

const chatsBefore = stores.chatStore.listChats().length;

describe("exam plan sync", () => {
	it("creates one session per focus in the exam folder, with an opening prompt", () => {
		writePlan(["Bias-Variance-Tradeoff", "Kreuzvalidierung"]);
		fs.writeFileSync(path.join(PLANS, "kaputt.md"), "kein Schwerpunkt");
		const result = syncExamPlans(BRAIN);
		assert.equal(result.created, 2);
		assert.equal(result.errors.length, 1, "a broken plan is reported, not fatal");
		const org = stores.sourceOrganizationStore.read();
		const folder = org.folders.find((f) => f.name === "FODS Klausur");
		assert.ok(folder, "folder created");
		const [overview] = examOverviews(BRAIN);
		assert.equal(overview!.exam, "FODS");
		assert.equal(overview!.planStart, localDay(Date.now()), "the progress line starts the day the plan was read");
		for (const f of overview!.focuses) {
			assert.equal(org.placements[f.chatId]?.folderId, folder!.id);
			assert.equal(stores.chatStore.getChat(f.chatId)?.title, f.title);
			assert.match(examOpeningPrompt(f.chatId) ?? "", new RegExp(`Focus: ${f.title}`));
		}
		assert.equal(stores.chatStore.listChats().length, chatsBefore + 2);
	});

	it("re-reading creates only new focuses, never duplicates", () => {
		writePlan(["Bias-Variance-Tradeoff", "Kreuzvalidierung", "Regularisierung"]);
		const result = syncExamPlans(BRAIN);
		assert.equal(result.created, 1);
		assert.equal(stores.chatStore.listChats().length, chatsBefore + 3);
		assert.equal(syncExamPlans(BRAIN).created, 0);
	});

	it("serves the opening prompt only until the session has a conversation", () => {
		const id = examOverviews(BRAIN)[0]!.focuses[0]!.chatId;
		stores.chatStore.saveMessages(id, [{ role: "user", content: "los", timestamp: Date.now() } as never]);
		assert.equal(examOpeningPrompt(id), undefined);
	});

	it("exports the exam with its progress into the stats and the overview", () => {
		exportToBrain(BRAIN);
		const stats = JSON.parse(fs.readFileSync(path.join(BRAIN, "wiki", "learnharness", "learnharness-stats.json"), "utf-8"));
		assert.equal(stats.exams.length, 1);
		assert.equal(stats.exams[0].exam, "FODS");
		assert.equal(stats.exams[0].date, "2026-11-20");
		assert.equal(stats.exams[0].total, 3);
		assert.equal(stats.exams[0].started, 1);
		assert.equal(typeof stats.exams[0].minutesByDay, "object", "per-day minutes for Daily");
		assert.ok(stats.exams[0].focuses.every((f: { chatId?: string }) => typeof f.chatId === "string"));
		const md = fs.readFileSync(path.join(BRAIN, "wiki", "learnharness", "lernstand.md"), "utf-8");
		assert.match(md, /## Klausuren\n\n### FODS — 2026-11-20\n\n1 von 3 Schwerpunkten angefangen/);
	});

	it("a plan taken out of Auftraege/ stops counting; put back, it reuses its sessions", () => {
		const moved = path.join(BRAIN, "fods-stillgelegt.md.bak");
		fs.renameSync(PLAN_FILE, moved);
		const before = stores.chatStore.listChats().length;
		syncExamPlans(BRAIN);
		assert.deepEqual(examOverviews(BRAIN).map((o) => o.exam), [], "retired: no longer in progress, notch or export");
		assert.equal(stores.chatStore.listChats().length, before, "its chats stay as ordinary chats");
		fs.renameSync(moved, PLAN_FILE);
		const back = syncExamPlans(BRAIN);
		assert.equal(back.created, 0, "the old sessions are reused, none duplicated");
		assert.deepEqual(examOverviews(BRAIN).map((o) => o.exam), ["FODS"]);
	});
});
