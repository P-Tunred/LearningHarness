/**
 * Exam progress (fork addition): the line Paul should be on, where he is,
 * and what today asks — pure arithmetic, no stores.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExamSummary } from "../src/core/brain-export.ts";
import { examProgress, minutesTodayAndWeek, paceFactor, restHours, restMinutesFocus, standingOf, weekStart } from "../src/core/exam-progress.ts";

type Focus = ExamSummary["focuses"][number];

function focus(title: string, over: Partial<Focus> = {}): Focus {
	return {
		title,
		chatId: `chat_${title}`,
		weight: null,
		effortHours: 10,
		started: false,
		learningMinutes: 0,
		timerMinutes: 0,
		openQuestions: 0,
		lastActive: null,
		planNodes: 0,
		progress: 0,
		understanding: null,
		done: 0,
		...over,
	};
}

function exam(focuses: Focus[], over: Partial<ExamSummary> = {}): ExamSummary {
	return {
		exam: "FODS Theorie",
		date: "2026-12-09",
		hoursPerWeek: 14,
		reviewFrom: "2026-11-25",
		planStart: "2026-10-31",
		total: focuses.length,
		minutesByDay: {},
		timerMinutesByDay: {},
		started: 0,
		learningMinutes: 0,
		openQuestions: 0,
		focuses,
		...over,
	};
}

const active = (p: ReturnType<typeof examProgress>) => {
	if (p.phase !== "study" && p.phase !== "revision") throw new Error(`unexpected phase ${p.phase}`);
	return p;
};

describe("examProgress — the line", () => {
	it("starts at zero on the plan's first day and on track", () => {
		const p = active(examProgress({ exam: exam([focus("A"), focus("B")]), planStart: "2026-10-31", today: "2026-10-31", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.soll, 0);
		assert.equal(p.ist, 0);
		assert.equal(p.deltaHours, 0);
		assert.equal(p.standing, "on-track");
	});

	it("halfway through the window with nothing done is behind by half the plan", () => {
		// 31.10 → 25.11 is 25 days; day 12.5 is not a date, so take 10 of 25 days.
		const p = active(examProgress({ exam: exam([focus("A"), focus("B")]), planStart: "2026-10-31", today: "2026-11-10", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.soll, 0.4);
		assert.equal(p.deltaHours, -8);
		assert.equal(p.standing, "far-behind");
	});

	it("is ahead when more is done than the line asks", () => {
		const p = active(examProgress({ exam: exam([focus("A", { done: 1, started: true }), focus("B")]), planStart: "2026-10-31", today: "2026-11-05", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.ist, 0.5);
		assert.equal(p.soll, 0.2);
		assert.equal(p.deltaHours, 6);
		assert.equal(p.standing, "ahead");
	});

	it("weights IST by effort, not by topic count", () => {
		const p = active(examProgress({ exam: exam([focus("Big", { effortHours: 9, done: 1 }), focus("Small", { effortHours: 1 })]), planStart: "2026-10-31", today: "2026-10-31", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.ist, 0.9);
	});

	it("falls back to today when the plan has no start", () => {
		const p = active(examProgress({ exam: exam([focus("A")]), planStart: null, today: "2026-11-10", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.soll, 0);
	});

	it("expects everything covered once revision starts", () => {
		const p = active(examProgress({ exam: exam([focus("A")]), planStart: "2026-10-31", today: "2026-11-30", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.phase, "revision");
		assert.equal(p.soll, 1);
	});
});

describe("examProgress — understanding", () => {
	it("is null before anything is graded", () => {
		const p = active(examProgress({ exam: exam([focus("A")]), planStart: "2026-10-31", today: "2026-11-01", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.understanding, null);
	});

	it("averages graded topics by effort", () => {
		const p = active(examProgress({
			exam: exam([focus("A", { effortHours: 3, understanding: 1 }), focus("B", { effortHours: 1, understanding: 0.6 }), focus("C")]),
			planStart: "2026-10-31", today: "2026-11-01", minutesToday: 0, minutesWeek: 0,
		}));
		assert.equal(p.understanding, 0.9);
	});
});

describe("examProgress — today", () => {
	it("spreads the rest over the study days left, rounded up to 15 min", () => {
		// 20 h over 25 days = 48 min → 60 min.
		const p = active(examProgress({ exam: exam([focus("A"), focus("B")]), planStart: "2026-10-31", today: "2026-10-31", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.daysLeft, 25);
		assert.equal(p.targetToday, 60);
		assert.equal(p.leftToday, 60);
	});

	it("does not shrink the target twice for time already spent today", () => {
		const base = { exam: exam([focus("A"), focus("B")]), planStart: "2026-10-31", today: "2026-10-31" };
		const before = active(examProgress({ ...base, minutesToday: 0, minutesWeek: 0 }));
		const after = active(examProgress({ ...base, minutesToday: 30, minutesWeek: 30 }));
		assert.equal(after.targetToday, before.targetToday);
		assert.equal(after.leftToday, before.leftToday - 30);
	});

	it("puts started topics first in what is up next", () => {
		const p = active(examProgress({
			exam: exam([focus("A"), focus("B", { started: true, done: 0.5 })], { hoursPerWeek: 70 }),
			planStart: "2026-10-31", today: "2026-11-24", minutesToday: 0, minutesWeek: 0,
		}));
		assert.equal(p.upNext[0]?.title, "B");
		assert.equal(p.upNext[0]?.chatId, "chat_B");
	});

	it("counts open questions as remaining work", () => {
		assert.equal(restHours(focus("A", { done: 1, openQuestions: 2 })), 0.5);
		assert.equal(restHours(focus("A", { done: 1, openQuestions: 40 })), 2);
	});

	it("reports no date and past exams without numbers", () => {
		assert.equal(examProgress({ exam: exam([focus("A")], { date: null }), planStart: null, today: "2026-11-01", minutesToday: 0, minutesWeek: 0 }).phase, "no-date");
		assert.equal(examProgress({ exam: exam([focus("A")]), planStart: null, today: "2026-12-10", minutesToday: 0, minutesWeek: 0 }).phase, "over");
	});
});

describe("helpers", () => {
	it("weeks start on Monday", () => {
		assert.equal(weekStart("2026-10-31"), "2026-10-26"); // Saturday
		assert.equal(weekStart("2026-11-02"), "2026-11-02"); // Monday
	});

	it("sums today and the week from per-day minutes", () => {
		const byDay = { "2026-10-25": 99, "2026-10-26": 30, "2026-10-31": 45, "2026-11-01": 10 };
		assert.deepEqual(minutesTodayAndWeek(byDay, "2026-10-31"), { today: 45, week: 75 });
	});

	it("tolerates small gaps as on track", () => {
		assert.equal(standingOf(-1.5, 60), "on-track"); // tolerance 1.8 h
		assert.equal(standingOf(-3, 60), "behind");
		assert.equal(standingOf(-6, 60), "far-behind");
		assert.equal(standingOf(2, 60), "ahead");
	});
});

describe("pace that learns (same cases as Daily's tests/lern-tempo.test.mjs)", () => {
	const pf = (effortHours: number, done: number, learningMinutes: number) => ({ effortHours, done, learningMinutes });

	it("needs two focuses at least 25 % and 30 min along", () => {
		assert.equal(paceFactor([pf(4, 0.5, 150)]), null);
		assert.equal(paceFactor([pf(4, 0.1, 50), pf(4, 0.2, 60)]), null);
	});

	it("slower than planned → factor above 1; faster → never below 0.5", () => {
		assert.equal(paceFactor([pf(4, 0.5, 180), pf(4, 1, 360)]), 1.5);
		assert.equal(paceFactor([pf(10, 1, 60), pf(10, 1, 60)]), 0.5);
	});

	it("planned 30 min, half done after 60 min → the rest runs at its own pace", () => {
		assert.equal(restMinutesFocus(focus("A", { effortHours: 0.5, done: 0.5, learningMinutes: 60 }), 1), 60);
	});

	it("little progress blends estimate and measurement", () => {
		assert.equal(restMinutesFocus(focus("A", { effortHours: 2, done: 0.2, learningMinutes: 60 }), 1), 154);
	});

	it("untouched: estimate × the subject's pace, plus open questions; finished is finished", () => {
		assert.equal(restMinutesFocus(focus("A", { effortHours: 2, openQuestions: 2 }), 1.5), 210);
		assert.equal(restMinutesFocus(focus("A", { effortHours: 2, done: 0.95, learningMinutes: 200 }), 2), 0);
	});

	it("a slow subject raises today's target above the plan's", () => {
		const slow = [
			focus("A", { effortHours: 4, done: 0.5, learningMinutes: 180, started: true }),
			focus("B", { effortHours: 4, done: 1, learningMinutes: 360, started: true }),
			focus("C", { effortHours: 4 }),
		];
		const p = active(examProgress({ exam: exam(slow), planStart: "2026-10-31", today: "2026-11-20", minutesToday: 0, minutesWeek: 0 }));
		assert.equal(p.pace, 1.5);
		// A: own pace 360 per whole, half left = 180; C: 4 h × 1.5 = 360 → 540 min over 5 days.
		assert.equal(p.restHours, 9);
		assert.equal(p.targetToday, 120);
		// The plan alone: 2 h + 4 h = 360 min over 5 days → 75.
		assert.equal(p.planTargetToday, 75);
	});

	it("falls back to the pace across all exams", () => {
		const others = [pf(4, 0.5, 180), pf(4, 1, 360)];
		const p = active(examProgress({ exam: exam([focus("A", { effortHours: 4 })]), planStart: "2026-10-31", today: "2026-11-05", minutesToday: 0, minutesWeek: 0, allFocuses: others }));
		assert.equal(p.pace, 1.5);
		assert.equal(p.restHours, 6);
	});
});
