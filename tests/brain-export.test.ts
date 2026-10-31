/**
 * Second Brain export (fork addition) — the pure half: learning time,
 * session digests, the coarse overview + stats, and inbox rules.
 * Session data comes from the real golden fixtures (never hand-written).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	IDLE_GAP_MS,
	buildBrainExport,
	digestSession,
	formatMinutes,
	inboxImportCandidate,
	learningTimeByDay,
	localDay,
	sessionContext,
	summarizeTopics,
} from "../src/core/brain-export.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { SourceOrganization } from "../src/core/source-organization.ts";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-data");
const goldenChat = (id: string) => JSON.parse(fs.readFileSync(path.join(GOLDEN, "chats", `${id}.json`), "utf-8")) as ChatRecord;
const TEACH = goldenChat("chat_mv27rrra_feff23b6");
const OTHER = goldenChat("chat_mv293wv5_10656952");

const MIN = 60_000;

describe("learningTimeByDay", () => {
	it("sums gaps up to the idle limit and drops longer pauses", () => {
		const t0 = new Date(2026, 9, 31, 9, 0).getTime();
		const byDay = learningTimeByDay([t0, t0 + 2 * MIN, t0 + 5 * MIN, t0 + 5 * MIN + IDLE_GAP_MS + 1, t0 + 20 * MIN]);
		// 2 + 3 counted; the >10-min pause dropped; the last gap (5 min − 1 ms) counted.
		const total = [...byDay.values()].reduce((a, b) => a + b, 0);
		assert.equal(total, 5 * MIN + (20 * MIN - (5 * MIN + IDLE_GAP_MS + 1)));
		assert.deepEqual([...byDay.keys()], [localDay(t0)]);
	});

	it("credits a gap to the day it ends on and ignores junk timestamps", () => {
		const late = new Date(2026, 9, 31, 23, 58).getTime();
		const byDay = learningTimeByDay([late, late + 4 * MIN, Number.NaN, -1]);
		assert.equal(byDay.get(localDay(late + 4 * MIN)), 4 * MIN);
		assert.equal(byDay.has(localDay(late)), false, "the gap ends after midnight");
	});
});

describe("digestSession (golden teach session)", () => {
	const d = digestSession(TEACH);

	it("counts answered questions, grading and unsure items from the answer records", () => {
		assert.equal(d.kind, "teach");
		assert.ok(d.questions > 0, "the fixture answers quiz/probe/recall questions");
		assert.ok(d.graded > 0 && d.correct <= d.graded);
		assert.ok(d.unsure.some((u) => u.reason === "dontKnow"), "the fixture contains a don't-know answer");
		assert.ok(d.unsure.some((u) => u.reason === "incorrect"), "and a wrong one");
		assert.ok(d.learningMs > 0);
	});

	it("never counts ask_user_question as a quiz", () => {
		const asks = TEACH.messages.filter((m) => (m as { details?: { kind?: string } }).details?.kind === "ask").length;
		assert.ok(asks > 0);
		const answered = TEACH.messages.filter((m) => {
			const det = (m as { role?: string; details?: { kind?: string; questionText?: unknown; dismissed?: boolean } });
			return det.role === "toolResult" && typeof det.details?.questionText === "string" && det.details.kind !== "ask" && det.details.dismissed !== true;
		}).length;
		assert.equal(d.questions, answered);
	});
});

describe("inbox candidates and formatting", () => {
	it("imports Markdown, text and PDF; never hidden or already imported files", () => {
		assert.equal(inboxImportCandidate("Skript Kapitel 5.pdf"), true);
		assert.equal(inboxImportCandidate("FODS/Notiz.MD"), true);
		assert.equal(inboxImportCandidate("hinweis.txt"), true);
		assert.equal(inboxImportCandidate("importiert/alt.md"), false);
		assert.equal(inboxImportCandidate(".DS_Store"), false);
		assert.equal(inboxImportCandidate("FODS/.trash/x.md"), false);
		assert.equal(inboxImportCandidate("bild.png"), false);
		assert.equal(inboxImportCandidate("../x.md"), false);
	});

	it("formats minutes in the Daily style", () => {
		assert.equal(formatMinutes(0), "0 min");
		assert.equal(formatMinutes(45), "45 min");
		assert.equal(formatMinutes(60), "1 h");
		assert.equal(formatMinutes(65), "1 h 05 min");
	});
});

describe("topics and context", () => {
	const organization: SourceOrganization = {
		version: 1,
		folders: [
			{ id: "f_uni", name: "FODS", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" },
			{ id: "f_w5", name: "Woche 5", parentId: "f_uni", createdAt: "2026-10-01T00:00:00.000Z" },
		],
		placements: { [TEACH.id]: { folderId: "f_w5" } },
	};

	it("names a session's context by its folder path", () => {
		assert.equal(sessionContext(organization, TEACH.id), "FODS / Woche 5");
		assert.equal(sessionContext(organization, OTHER.id), null, "root sessions have no context");
		assert.equal(sessionContext(undefined, TEACH.id), null);
	});

	it("groups same-titled sessions into one topic and sums their time", () => {
		const twin = { ...OTHER, title: ` ${TEACH.title.toUpperCase()} ` } as ChatRecord;
		const topics = summarizeTopics([TEACH, twin], organization, new Date("2027-01-01T00:00:00Z"));
		assert.equal(topics.length, 1);
		const [t] = topics;
		assert.equal(t!.sessions, 2);
		const total = Math.round((digestSession(TEACH).learningMs + digestSession(twin).learningMs) / MIN);
		assert.ok(Math.abs(t!.learningMinutesTotal - total) <= 1);
		assert.equal(t!.learningMinutesRecent, 0, "nothing within 14 days of 2027-01-01");
	});
});

describe("buildBrainExport", () => {
	const graph = { nodes: [], chains: [] };
	const lastAction = Math.max(...[TEACH, OTHER].flatMap((c) => c.messages.map((m) => (m as { timestamp?: number }).timestamp ?? 0)));
	const now = new Date(lastAction + 60 * MIN).toISOString();
	const out = buildBrainExport({ chats: [TEACH, OTHER], graph, now });

	it("writes only the coarse overview and the stats — no per-proposition notes", () => {
		assert.deepEqual([...out.files.keys()].sort(), ["learnharness-stats.json", "lernstand.md"]);
	});

	it("keeps the overview coarse: topics and minutes, never questions or statements", () => {
		const md = out.files.get("lernstand.md")!;
		assert.match(md, /^# Lernstand \(LearnHarness\)\n/);
		assert.match(md, /## Gerade dran \(letzte 14 Tage\)\n\n\| Thema \| Rahmen/);
		assert.match(md, /## Quellen\n/);
		for (const u of digestSession(TEACH).unsure) assert.ok(!md.includes(u.question.slice(0, 40)), "no question text");
	});

	it("produces dashboard stats consistent with the digests", () => {
		const stats = JSON.parse(out.files.get("learnharness-stats.json")!);
		assert.equal(stats.version, 3);
		assert.equal(stats.generatedAt, now);
		assert.equal(stats.idleGapMinutes, 10);
		assert.equal(stats.recentDays, 14);
		assert.equal(stats.totals.sessions, 2);
		assert.equal(stats.totals.questions, digestSession(TEACH).questions + digestSession(OTHER).questions);
		assert.ok(stats.totals.learningMinutesRecent > 0, "the golden sessions are recent relative to now");
		assert.ok(stats.topics.length >= 1 && stats.topics.length <= 2);
		assert.ok(stats.topics.every((t: { lastActive: string }) => /^\d{4}-\d{2}-\d{2}$/.test(t.lastActive)));
		assert.ok(!("note" in stats.sessions[0]), "no links to per-session notes any more");
		const dayMinutes = stats.days.reduce((s: number, day: { learningMinutes: number }) => s + day.learningMinutes, 0);
		assert.ok(Math.abs(dayMinutes - stats.totals.learningMinutes) <= stats.days.length, "per-day rounding only");
	});

	it("is deterministic for the same input", () => {
		const again = buildBrainExport({ chats: [OTHER, TEACH], graph, now });
		assert.deepEqual([...again.files.entries()].sort(), [...out.files.entries()].sort());
	});
});

describe("study timer in the export (version 3)", () => {
	const graph = { nodes: [], chains: [] };
	const actions = TEACH.messages.map((m) => (m as { timestamp?: number }).timestamp ?? 0).filter((t) => t > 0);
	const first = Math.min(...actions);
	const day = localDay(first);
	const estimateMin = Math.round((digestSession(TEACH).learningByDay.get(day) ?? 0) / MIN);
	const now = new Date(Math.max(...actions) + 60 * MIN).toISOString();
	const exams = [{ exam: "FODS Theorie", date: "2099-01-01", focuses: [{ title: "Teach", weight: null, chatId: TEACH.id }] }];
	const run = (pieces: Array<{ subject: string | null; chatId: string | null; start: number; end: number }>) =>
		JSON.parse(buildBrainExport({ chats: [TEACH, OTHER], graph, exams, timerPieces: pieces, now }).files.get("learnharness-stats.json")!);

	it("takes the measured time where it is larger, per session and day", () => {
		const long = (estimateMin + 45) * MIN;
		const stats = run([{ subject: "FODS Theorie", chatId: TEACH.id, start: first, end: first + long }]);
		const row = stats.sessions.find((s: { id: string }) => s.id === TEACH.id);
		assert.equal(row.learningMinutes, Math.round(long / MIN));
		const [exam] = stats.exams;
		assert.equal(exam.minutesByDay[day], Math.round(long / MIN));
		assert.equal(exam.timerMinutesByDay[day], Math.round(long / MIN));
		assert.equal(exam.focuses[0].timerMinutes, Math.round(long / MIN));
		assert.equal(exam.focuses[0].learningMinutes, Math.round(long / MIN));
	});

	it("keeps the estimate where the timer measured less — never the sum", () => {
		const stats = run([{ subject: "FODS Theorie", chatId: TEACH.id, start: first, end: first + MIN }]);
		const row = stats.sessions.find((s: { id: string }) => s.id === TEACH.id);
		assert.equal(row.learningMinutes, Math.round(digestSession(TEACH).learningMs / MIN));
		assert.equal(stats.exams[0].focuses[0].timerMinutes, 1);
		assert.equal(stats.exams[0].minutesByDay[day], Math.max(estimateMin, 1));
	});

	it("lists measured minutes per day and subject, unassigned time under Ohne Fach", () => {
		const stats = run([
			{ subject: "FODS Theorie", chatId: TEACH.id, start: first, end: first + 30 * MIN },
			{ subject: null, chatId: OTHER.id, start: first + 30 * MIN, end: first + 40 * MIN },
			{ subject: "Statistik", chatId: null, start: first - 400 * 24 * 60 * MIN, end: first - 400 * 24 * 60 * MIN + 30 * MIN },
		]);
		assert.deepEqual(stats.timer.byDay[day], { "FODS Theorie": 30, "Ohne Fach": 10 });
		assert.equal(Object.keys(stats.timer.byDay).length, 1, "older than 28 days is left out");
	});

	it("time booked to the exam's name from another chat counts for the exam", () => {
		const stats = run([{ subject: "FODS Theorie", chatId: OTHER.id, start: first, end: first + (estimateMin + 20) * MIN }]);
		assert.equal(stats.exams[0].timerMinutesByDay[day], estimateMin + 20);
		assert.equal(stats.exams[0].minutesByDay[day], estimateMin + 20);
		assert.equal(stats.exams[0].focuses[0].timerMinutes, 0, "not this focus's time");
	});

	it("without a timer the old fields are unchanged and timer.byDay is empty", () => {
		const stats = JSON.parse(buildBrainExport({ chats: [TEACH, OTHER], graph, exams, now }).files.get("learnharness-stats.json")!);
		assert.deepEqual(stats.timer, { byDay: {} });
		assert.equal(stats.exams[0].minutesByDay[day], estimateMin || undefined);
		assert.deepEqual(stats.exams[0].timerMinutesByDay, {});
	});
});
