/**
 * Study timer box (fork addition): the current session resets after Save,
 * today adds up across subjects, and blocks/saved sessions say when.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beat, emptyTimerState, pause, save, start, timerSummary, type TimerState } from "../src/core/study-timer.ts";

/** Learn from `from` to `to` with a heartbeat (and input) every 30 s, as the window does. */
function learn(st: TimerState, from: number, to: number, ctx: { subject: string; chatId: string }, stop = true): TimerState {
	let s = start(st, from, ctx);
	for (let t = from + 30_000; t <= to; t += 30_000) s = beat(s, t, t);
	return stop ? pause(s, to) : s;
}

const MIN = 60_000;
const T0 = new Date(2026, 10, 4, 9, 0, 0).getTime();
const fods = { subject: "FODS", chatId: "chat_a" };
const stats = { subject: "Stats", chatId: "chat_b" };

describe("timerSummary", () => {
	it("is empty before anything ran", () => {
		const s = timerSummary(emptyTimerState(), T0);
		assert.deepEqual(s, { sessionMs: 0, sessionStart: null, todayTotalMs: 0, todayBySubject: [], todayBlocks: [], savedToday: [] });
	});

	it("counts the running session, pauses included as breaks, and resets after Save", () => {
		let st = learn(emptyTimerState(), T0, T0 + 25 * MIN, fods);
		st = learn(st, T0 + 30 * MIN, T0 + 40 * MIN, fods, false); // after a 5 min break
		let s = timerSummary(st, T0 + 40 * MIN);
		assert.equal(s.sessionMs, 35 * MIN);
		assert.equal(s.sessionStart, T0);
		assert.equal(s.todayBlocks.length, 2, "the break splits the blocks");

		st = save(st, T0 + 40 * MIN);
		s = timerSummary(st, T0 + 41 * MIN);
		assert.equal(s.sessionMs, 0, "after Save the session starts from zero");
		assert.equal(s.sessionStart, null);
		assert.equal(s.todayTotalMs, 35 * MIN, "today keeps the saved time");
		assert.deepEqual(s.savedToday.map((x) => [x.subject, x.minutes]), [["FODS", 35]]);
		assert.ok(s.todayBlocks.every((b) => b.saved));
	});

	it("adds today up per subject, largest first, and merges back-to-back pieces", () => {
		let st = learn(emptyTimerState(), T0, T0 + 10 * MIN, stats);
		st = learn(st, T0 + 10 * MIN, T0 + 50 * MIN, fods);
		st = learn(st, T0 + 50 * MIN + 30_000, T0 + 60 * MIN, fods, false); // 30 s gap: same block
		const s = timerSummary(st, T0 + 60 * MIN);
		assert.deepEqual(s.todayBySubject.map((x) => [x.subject, Math.round(x.ms / MIN)]), [["FODS", 50], ["Stats", 10]]);
		assert.equal(s.todayTotalMs, 60 * MIN - 30_000);
		assert.deepEqual(s.todayBlocks.map((b) => [b.subject, (b.start - T0) / MIN, Math.round((b.end - T0) / MIN)]), [["Stats", 0, 10], ["FODS", 10, 60]]);
	});

	it("only counts today's part of a piece across midnight", () => {
		const late = new Date(2026, 10, 3, 23, 30, 0).getTime();
		const st = learn(emptyTimerState(), late, late + 60 * MIN, fods, false);
		const s = timerSummary(st, late + 60 * MIN);
		assert.equal(s.todayTotalMs, 30 * MIN);
		assert.equal(s.sessionMs, 60 * MIN, "the open session is the whole run");
	});
});
