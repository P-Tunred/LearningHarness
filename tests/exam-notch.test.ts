/**
 * Exam notch (fork addition): which exam the closed notch speaks for, and
 * its "today" wording.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nearestExam, todayLine, topicOfChat } from "../components/exam-notch.tsx";

describe("exam notch", () => {
	it("speaks for the nearest exam", () => {
		const exams = [{ exam: "B", daysToExam: 40 }, { exam: "A", daysToExam: 12 }, { exam: "C", daysToExam: 90 }];
		assert.equal(nearestExam(exams)?.exam, "A");
		assert.equal(nearestExam([]), undefined);
		assert.deepEqual(exams.map((e) => e.exam), ["B", "A", "C"], "input order untouched");
	});

	it("in a topic chat: that chat's exam and topic; elsewhere none", () => {
		const exams = [
			{ exam: "A", focuses: [{ title: "PCA", chatId: "c1", done: 0.64 }] },
			{ exam: "B", focuses: [{ title: "Graphs", chatId: "c2", done: 0.2 }, { title: "Plan only", done: 0 }] },
		];
		const hit = topicOfChat(exams, "c2");
		assert.equal(hit?.exam.exam, "B");
		assert.equal(hit?.focus.title, "Graphs");
		assert.equal(topicOfChat(exams, "other"), undefined);
		assert.equal(topicOfChat(exams, null), undefined);
	});

	it("says what is left today, or that today is done", () => {
		assert.equal(todayLine({ leftToday: 25, targetToday: 60 }), "25 min to go");
		assert.equal(todayLine({ leftToday: 90, targetToday: 90 }), "1 h 30 to go");
		assert.equal(todayLine({ leftToday: 0, targetToday: 60 }), "today done ✓");
	});
});
