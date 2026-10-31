/**
 * Study timer (fork addition) — the pure half: subject assignment, chat
 * switches, idle and sleep, and how pieces add up per day.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceOrganization } from "../src/core/source-organization.ts";
import {
	IDLE_ASK_MS,
	IDLE_PAUSE_MS,
	NO_SUBJECT,
	STALE_MS,
	allPieces,
	assignSubject,
	beat,
	emptyTimerState,
	msByChatDay,
	msBySubjectDay,
	parseTimerState,
	pause,
	settle,
	splitByDay,
	start,
	subjectChoices,
	subjectForChat,
	switchContext,
	todayForSubject,
	topFolderName,
	type SubjectSources,
	type TimerState,
} from "../src/core/study-timer.ts";

const MIN = 60_000;
/** Local noon on 31 Oct 2026 — day math in the machine's own time zone. */
const T0 = new Date(2026, 9, 31, 12, 0, 0).getTime();

const org = {
	folders: [
		{ id: "f-fods", name: "FODS Theorie Klausur", parentId: null },
		{ id: "f-stat", name: "Statistik", parentId: null },
		{ id: "f-week", name: "Woche 5", parentId: "f-stat" },
	],
	placements: {
		"c-focus": { folderId: "f-fods" },
		"c-stat": { folderId: "f-week" },
	},
} as unknown as SourceOrganization;

/** The window beats every minute from `from` to `to` (minutes after T0),
 *  with input at each beat unless `activeAt` pins the last input. */
function beats(state: TimerState, from: number, to: number, activeAt?: number): TimerState {
	let s = state;
	for (let m = from; m <= to; m++) s = beat(s, T0 + m * MIN, activeAt ?? T0 + m * MIN);
	return s;
}

const sources = (chatSubjects: Record<string, string> = {}): SubjectSources => ({
	examByChat: new Map([["c-focus", "FODS Theorie"]]),
	organization: org,
	chatSubjects,
});

describe("subject assignment", () => {
	it("an exam focus session belongs to the exam, not its folder", () => {
		assert.equal(subjectForChat("c-focus", sources()), "FODS Theorie");
	});

	it("a chat in a folder belongs to the top-level folder", () => {
		assert.equal(topFolderName(org, "c-stat"), "Statistik");
		assert.equal(subjectForChat("c-stat", sources()), "Statistik");
	});

	it("a chat at the root has no subject until Paul picks one", () => {
		assert.equal(subjectForChat("c-loose", sources()), null);
		assert.equal(subjectForChat("c-loose", sources({ "c-loose": "KM" })), "KM");
		assert.equal(subjectForChat(null, sources()), null);
	});

	it("a hand-picked subject wins over the automatic one", () => {
		assert.equal(subjectForChat("c-stat", sources({ "c-stat": "FODS Theorie" })), "FODS Theorie");
	});

	it("offers exams, top-level folders and hand-picked subjects", () => {
		assert.deepEqual(subjectChoices(sources({ x: "KM" })), ["FODS Theorie", "KM", "Statistik"], "the exam's own folder is not a second subject");
	});
});

describe("running, pausing, switching", () => {
	it("does not start by itself and books nothing while paused", () => {
		let s = emptyTimerState();
		s = switchContext(s, T0, { subject: "FODS Theorie", chatId: "c-focus" });
		assert.equal(s.running, null);
		assert.deepEqual(s.context, { subject: "FODS Theorie", chatId: "c-focus" });
		assert.equal(allPieces(s, T0 + 60 * MIN).length, 0);
	});

	it("start → pause books one piece in the shown context", () => {
		let s = switchContext(emptyTimerState(), T0, { subject: "FODS Theorie", chatId: "c-focus" });
		s = start(s, T0);
		s = beats(s, 1, 25);
		s = pause(s, T0 + 25 * MIN);
		assert.deepEqual(s.pieces, [{ subject: "FODS Theorie", chatId: "c-focus", start: T0, end: T0 + 25 * MIN }]);
		assert.equal(s.running, null);
	});

	it("a chat switch ends the old piece and starts the new one at the same instant", () => {
		let s = start(switchContext(emptyTimerState(), T0, { subject: "FODS Theorie", chatId: "c-focus" }), T0);
		s = beats(s, 1, 20);
		s = switchContext(s, T0 + 20 * MIN, { subject: "Statistik", chatId: "c-stat" });
		s = beats(s, 21, 30);
		s = pause(s, T0 + 30 * MIN);
		assert.deepEqual(s.pieces.map((p) => [p.subject, p.chatId, (p.end - p.start) / MIN]), [
			["FODS Theorie", "c-focus", 20],
			["Statistik", "c-stat", 10],
		]);
		assert.equal(s.pieces[0]!.end, s.pieces[1]!.start, "no gap, no overlap");
	});

	it("re-opening the same chat changes nothing; leaving to the graph keeps the context", () => {
		let s = start(switchContext(emptyTimerState(), T0, { subject: "FODS Theorie", chatId: "c-focus" }), T0);
		s = beats(s, 1, 5);
		s = switchContext(s, T0 + 5 * MIN, { subject: "FODS Theorie", chatId: "c-focus" });
		s = beats(s, 6, 6);
		s = switchContext(s, T0 + 6 * MIN, { subject: null, chatId: null });
		assert.equal(s.pieces.length, 0);
		assert.equal(s.running?.chatId, "c-focus");
	});

	it("starting twice keeps the first start", () => {
		let s = beats(start(emptyTimerState(), T0), 1, 5);
		s = start(s, T0 + 5 * MIN);
		assert.equal(s.running?.start, T0);
	});

	it("picking a subject relabels the running piece of that chat, not earlier ones", () => {
		let s = start(switchContext(emptyTimerState(), T0, { subject: null, chatId: "c-loose" }), T0);
		s = beats(s, 1, 5);
		s = switchContext(s, T0 + 5 * MIN, { subject: "Statistik", chatId: "c-stat" });
		s = beats(s, 6, 10);
		s = switchContext(s, T0 + 10 * MIN, { subject: null, chatId: "c-loose" });
		s = beats(s, 11, 12);
		s = assignSubject(s, T0 + 12 * MIN, "c-loose", "KM");
		s = beats(s, 13, 15);
		s = pause(s, T0 + 15 * MIN);
		assert.deepEqual(s.pieces.map((p) => p.subject), [null, "Statistik", "KM"]);
		assert.equal(s.chatSubjects["c-loose"], "KM");
	});
});

describe("idle and sleep", () => {
	const running = () => start(switchContext(emptyTimerState(), T0, { subject: "FODS Theorie", chatId: "c-focus" }), T0);

	it("keeps running while input keeps coming", () => {
		const s = beats(running(), 1, 60);
		assert.ok(s.running);
	});

	it("still runs at the question (15 min idle), so an answer keeps everything", () => {
		let s = beats(running(), 1, 17, T0 + 2 * MIN);
		assert.ok(s.running, "asked, not paused yet");
		assert.ok(T0 + 17 * MIN - s.running!.activeAt >= IDLE_ASK_MS);
		s = beats(s, 18, 30); // "Yes, still here", then active again
		s = pause(s, T0 + 30 * MIN);
		assert.equal(s.pieces[0]!.end - s.pieces[0]!.start, 30 * MIN);
	});

	it("pauses after 20 min without input and books only up to the last input", () => {
		const s = beats(running(), 1, 25, T0 + 3 * MIN);
		assert.equal(s.running, null);
		assert.equal(s.stopped, "idle");
		assert.deepEqual(s.pieces.map((p) => (p.end - p.start) / MIN), [3]);
	});

	it("coming back just before the pause keeps the timer running", () => {
		let s = beats(running(), 1, 19, T0);
		s = beat(s, T0 + IDLE_PAUSE_MS + 10_000, T0 + IDLE_PAUSE_MS - 5_000);
		assert.ok(s.running);
	});

	it("sleep: a late beat ends the piece at the last beat and stays paused", () => {
		let s = beats(running(), 1, 10);
		s = beat(s, T0 + 10 * MIN + STALE_MS + 60 * MIN, T0 + 10 * MIN + STALE_MS + 60 * MIN);
		assert.equal(s.running, null);
		assert.equal(s.stopped, "asleep");
		assert.deepEqual(s.pieces.map((p) => (p.end - p.start) / MIN), [10]);
	});

	it("quit or crash: the next read settles at the last beat", () => {
		let s = beats(running(), 1, 7);
		s = settle(s, T0 + 7 * MIN + STALE_MS);
		assert.deepEqual(s.pieces.map((p) => (p.end - p.start) / MIN), [7]);
	});

	it("sleeping while the question was open does not book the unanswered stretch", () => {
		let s = beats(running(), 1, 17, T0 + MIN);
		s = settle(s, T0 + 17 * MIN + STALE_MS);
		assert.deepEqual(s.pieces.map((p) => (p.end - p.start) / MIN), [1]);
	});

	it("a restart after a pause starts fresh and clears the reason", () => {
		const s0 = beats(running(), 1, 21, T0);
		assert.equal(s0.stopped, "idle");
		let s = s0;
		s = start(s, T0 + 60 * MIN);
		assert.equal(s.stopped, null);
		assert.equal(s.running?.subject, "FODS Theorie", "Weiter books where it left off");
	});
});

describe("adding up", () => {
	it("splits a piece across local midnight", () => {
		const late = new Date(2026, 9, 31, 23, 30).getTime();
		assert.deepEqual(splitByDay({ start: late, end: late + 60 * MIN }), [["2026-10-31", 30 * MIN], ["2026-11-01", 30 * MIN]]);
	});

	it("sums per chat and day, and per subject and day with the running piece", () => {
		let s = start(switchContext(emptyTimerState(), T0, { subject: "FODS Theorie", chatId: "c-focus" }), T0);
		s = beats(s, 1, 30);
		s = switchContext(s, T0 + 30 * MIN, { subject: null, chatId: "c-loose" });
		s = beats(s, 31, 40);
		const pieces = allPieces(s, T0 + 40 * MIN);
		assert.equal(msByChatDay(pieces).get("c-focus")?.get("2026-10-31"), 30 * MIN);
		const bySubject = msBySubjectDay(pieces, "2026-10-01").get("2026-10-31");
		assert.equal(bySubject?.get("FODS Theorie"), 30 * MIN);
		assert.equal(bySubject?.get(NO_SUBJECT), 10 * MIN);
		assert.equal(todayForSubject(s, T0 + 40 * MIN, "FODS Theorie"), 30 * MIN);
	});
});

describe("stored state", () => {
	it("round-trips and drops malformed pieces", () => {
		let s = start(emptyTimerState(), T0, { subject: "KM", chatId: "c" });
		s = beats(s, 1, 5);
		s = pause(s, T0 + 5 * MIN);
		const back = parseTimerState(JSON.parse(JSON.stringify({ ...s, pieces: [...s.pieces, { start: 5, end: 1 }, null] })));
		assert.deepEqual(back.pieces, s.pieces);
		assert.deepEqual(parseTimerState({ version: 9 }), emptyTimerState());
	});
});
