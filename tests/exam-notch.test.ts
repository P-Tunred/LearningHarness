/**
 * Exam notch (fork addition): which exam the closed notch speaks for, and
 * its "today" wording.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nearestExam, todayLine } from "../components/exam-notch.tsx";

describe("exam notch", () => {
	it("speaks for the nearest exam", () => {
		const exams = [{ exam: "B", daysToExam: 40 }, { exam: "A", daysToExam: 12 }, { exam: "C", daysToExam: 90 }];
		assert.equal(nearestExam(exams)?.exam, "A");
		assert.equal(nearestExam([]), undefined);
		assert.deepEqual(exams.map((e) => e.exam), ["B", "A", "C"], "input order untouched");
	});

	it("says what is left today, or that today is done", () => {
		assert.equal(todayLine({ leftToday: 25, targetToday: 60 }), "25 min to go");
		assert.equal(todayLine({ leftToday: 90, targetToday: 90 }), "1 h 30 to go");
		assert.equal(todayLine({ leftToday: 0, targetToday: 60 }), "today done ✓");
	});
});
