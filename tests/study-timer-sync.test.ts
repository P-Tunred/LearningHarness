/**
 * Study timer (fork addition) — the stored half against real files: a temp
 * copy of the golden data dir and a temp brain with one exam plan. The
 * timer must find the subject of each chat by itself, book a chat switch
 * to the right subject, survive a "crash", skip idle time, and the
 * measured minutes must reach the brain export.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { localDay } from "../src/core/brain-export.ts";
import { IDLE_PAUSE_MS, STALE_MS } from "../src/core/study-timer.ts";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-data");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-timer-data-"));
fs.cpSync(GOLDEN, DATA, { recursive: true });
process.env.LH_DATA_DIR = DATA;
// The real path: LearnHarness resolves the configured folder before it
// keys the exam state on it (macOS tmp dirs are symlinks).
const BRAIN = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-timer-brain-")));
fs.mkdirSync(path.join(BRAIN, "wiki"), { recursive: true });
fs.mkdirSync(path.join(BRAIN, "LearnHarness", "Auftraege"), { recursive: true });
fs.writeFileSync(path.join(BRAIN, "LearnHarness", "Auftraege", "fods.md"), [
	"---", "exam: FODS Theorie", "date: 2099-12-09", "---",
	"## Trees", "Weight: high", "Effort: 3 h", "",
	"## Clustering", "Weight: low", "",
].join("\n"));
const settingsFile = path.join(DATA, "settings.json");
fs.writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsFile, "utf-8")), brain: { folder: BRAIN } }));

const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const { syncExamPlans, examOverviews } = await import("../src/server/exam-plans.ts");
const { studyTimerAction, studyTimerView, parseTimerAction, readTimerState, STUDY_TIMER_FILE } = await import("../src/server/study-timer.ts");
const { exportToBrain } = await import("../src/server/brain.ts");

const MIN = 60_000;
const T0 = new Date(2099, 10, 2, 10, 0).getTime();
const DAY = localDay(T0);

syncExamPlans(BRAIN);
const [exam] = examOverviews(BRAIN);
const focusChat = exam!.focuses.find((f) => f.title === "Trees")!.chatId;
const statFolder = sourceDirectory.change({ action: "create-folder", name: "Statistik", parentId: null }).createdFolderId!;
const weekFolder = sourceDirectory.change({ action: "create-folder", name: "Woche 5", parentId: statFolder }).createdFolderId!;
const statChat = stores.chatStore.createChat("Hypothesis tests").id;
sourceDirectory.change({ action: "move", kind: "source", id: statChat, parentId: weekFolder });
const looseChat = stores.chatStore.createChat("Loose question").id;

/** Beat every minute from `from` to `to` (minutes after T0). */
function beats(from: number, to: number, activeAt?: number) {
	for (let m = from; m <= to; m++) studyTimerAction({ action: "beat", activeAt: activeAt ?? T0 + m * MIN }, T0 + m * MIN);
}

describe("study timer, stored", () => {
	it("shows each chat's subject while paused and never starts by itself", () => {
		assert.equal(studyTimerView(focusChat, T0).subject, "FODS Theorie");
		assert.equal(studyTimerView(statChat, T0).subject, "Statistik");
		const loose = studyTimerView(looseChat, T0);
		assert.equal(loose.subject, null);
		assert.equal(loose.running, false);
		assert.ok(loose.choices.includes("FODS Theorie") && loose.choices.includes("Statistik"));
	});

	it("books a chat switch to the new subject from the switch on", () => {
		studyTimerAction({ action: "start", chatId: focusChat }, T0);
		beats(1, 20);
		// The window opens the other chat: its read moves the run along.
		assert.equal(studyTimerView(statChat, T0 + 20 * MIN).subject, "Statistik");
		beats(21, 30);
		const v = studyTimerAction({ action: "toggle", chatId: statChat }, T0 + 30 * MIN);
		assert.equal(v.running, false);
		assert.deepEqual(readTimerState().pieces.map((p) => [p.subject, p.chatId, (p.end - p.start) / MIN]), [
			["FODS Theorie", focusChat, 20],
			["Statistik", statChat, 10],
		]);
	});

	it("assigns a loose chat by hand and remembers it", () => {
		studyTimerAction({ action: "start", chatId: looseChat }, T0 + 40 * MIN);
		studyTimerAction({ action: "assign", chatId: looseChat, subject: "FODS Theorie" }, T0 + 41 * MIN);
		beats(42, 45);
		studyTimerAction({ action: "pause" }, T0 + 45 * MIN);
		assert.equal(readTimerState().pieces.at(-1)?.subject, "FODS Theorie");
		assert.equal(studyTimerView(looseChat, T0 + 46 * MIN).subject, "FODS Theorie");
	});

	it("idle: pauses after 20 min without input and books only up to the last input", () => {
		studyTimerAction({ action: "start", chatId: focusChat }, T0 + 60 * MIN);
		beats(61, 65);
		beats(66, 60 + 5 + IDLE_PAUSE_MS / MIN + 1, T0 + 65 * MIN);
		const v = studyTimerView(focusChat, T0 + 95 * MIN);
		assert.equal(v.running, false);
		assert.equal(v.stopped, "idle");
		const last = readTimerState().pieces.at(-1)!;
		assert.equal((last.end - last.start) / MIN, 5);
	});

	it("crash: the running piece is on disk and the next read ends it at the last beat", () => {
		studyTimerAction({ action: "start", chatId: focusChat }, T0 + 120 * MIN);
		beats(121, 127);
		assert.ok(JSON.parse(fs.readFileSync(STUDY_TIMER_FILE, "utf-8")).running, "running piece stored");
		const v = studyTimerView(focusChat, T0 + 127 * MIN + STALE_MS + 5 * MIN);
		assert.equal(v.running, false);
		assert.equal(v.stopped, "asleep");
		assert.equal((readTimerState().pieces.at(-1)!.end - (T0 + 120 * MIN)) / MIN, 7);
	});

	it("rejects malformed actions", () => {
		assert.throws(() => parseTimerAction({ action: "explode" }));
		assert.throws(() => parseTimerAction({ action: "beat" }));
		assert.deepEqual(parseTimerAction({ action: "assign", chatId: "x", subject: "  " }), { action: "assign", chatId: "x", subject: null });
	});

	it("exports the measured time per subject, exam and focus", () => {
		exportToBrain(BRAIN, new Date(T0 + 200 * MIN));
		const stats = JSON.parse(fs.readFileSync(path.join(BRAIN, "wiki", "learnharness", "learnharness-stats.json"), "utf-8"));
		assert.equal(stats.version, 3);
		// FODS: 20 (focus) + 5 (loose chat booked to the exam) + 5 (idle run) + 7 (crash run).
		assert.deepEqual(stats.timer.byDay[DAY], { "FODS Theorie": 37, Statistik: 10 });
		const fods = stats.exams.find((e: { exam: string }) => e.exam === "FODS Theorie");
		assert.equal(fods.timerMinutesByDay[DAY], 37);
		assert.equal(fods.minutesByDay[DAY], 37, "no messages in these chats: measured wins");
		const trees = fods.focuses.find((f: { title: string }) => f.title === "Trees");
		assert.equal(trees.timerMinutes, 32);
		assert.equal(trees.learningMinutes, 32);
		assert.equal(fods.focuses.find((f: { title: string }) => f.title === "Clustering").timerMinutes, 0);
	});
});
