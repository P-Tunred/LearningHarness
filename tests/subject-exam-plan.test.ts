/**
 * Subject → exam plan (fork addition, 2026-11-11): new topics of a reviewed
 * subject are appended to the exam plan that opted in with `fach:`, in
 * learning order, never touching what is there.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendNewTopics, learningOrder, MAX_EXAM_FOCUSES, planSubject } from "../src/core/subject-exam-plan.ts";
import { parseExamPlan } from "../src/core/exam-plan.ts";
import type { Topic } from "../src/core/subject-review.ts";

const topic = (title: string, extra: Partial<Topic> = {}): Topic => ({
	title,
	weight: "medium",
	effortHours: 2,
	learnerState: "not-started",
	prerequisites: [],
	sources: [],
	examEvidence: "",
	goal: `Understand ${title}.`,
	note: "",
	status: "active",
	...extra,
});

const HEAD = "---\nklausur: INTSEC\ndatum: 2027-01-09\nfach: IntSec\n---\n# INTSEC\nContext.\n";

describe("subject → exam plan", () => {
	it("reads the subject the plan opted into", () => {
		assert.equal(planSubject(HEAD), "IntSec");
		assert.equal(planSubject("---\nklausur: FODS\n---\n## A"), null);
		assert.equal(planSubject("## no front matter"), null);
	});

	it("orders topics after their prerequisites, heavier first among the ready", () => {
		const order = learningOrder([
			topic("Passwords", { prerequisites: ["CIA", "Hashes"], weight: "high" }),
			topic("Hashes", { prerequisites: ["CIA"], weight: "high" }),
			topic("Privacy", { weight: "low" }),
			topic("CIA"),
			topic("Old", { status: "obsolete" }),
		]).map((t) => t.title);
		assert.deepEqual(order, ["CIA", "Hashes", "Passwords", "Privacy"]);
	});

	it("a capstone that builds on everything comes last, even when heavy", () => {
		const order = learningOrder([
			topic("Exam training", { prerequisites: ["Hashes", "Passwords"], weight: "high" }),
			topic("CIA"),
			topic("Hashes", { prerequisites: ["CIA"], weight: "high" }),
			topic("Passwords", { prerequisites: ["Hashes"], weight: "high" }),
			topic("STRIDE", { prerequisites: ["CIA"] }),
			topic("PKI", { prerequisites: ["Hashes"] }),
		]).map((t) => t.title);
		assert.equal(order.at(-1), "Exam training");
		assert.equal(order[0], "CIA");
	});

	it("survives a prerequisite cycle", () => {
		const order = learningOrder([topic("A", { prerequisites: ["B"] }), topic("B", { prerequisites: ["A"] })]);
		assert.equal(order.length, 2);
	});

	it("appends only what is missing and leaves existing sections alone", () => {
		const first = appendNewTopics(HEAD, [topic("CIA"), topic("Hashes", { prerequisites: ["CIA"], weight: "high" })]);
		assert.deepEqual(first.added, ["CIA", "Hashes"]);
		const edited = first.text.replace("Understand CIA.", "Paul's own note.");
		const second = appendNewTopics(edited, [topic("cia"), topic("Hashes"), topic("AI threats", { weight: "low" })]);
		assert.deepEqual(second.added, ["AI threats"]);
		assert.ok(second.text.startsWith(edited.trimEnd()), "existing text untouched");
		const plan = parseExamPlan(second.text, "intsec.md");
		assert.deepEqual(plan.focuses.map((f) => f.title), ["CIA", "Hashes", "AI threats"]);
		assert.equal(plan.focuses[1]!.weight, "hoch");
		assert.equal(plan.focuses[1]!.effortHours, 2);
		assert.equal(appendNewTopics(second.text, [topic("AI threats")]).added.length, 0, "nothing new, nothing written");
	});

	it("never appends past the plan's focus limit", () => {
		const many = Array.from({ length: MAX_EXAM_FOCUSES + 3 }, (_, i) => topic(`T${i}`));
		const r = appendNewTopics(HEAD, many);
		assert.equal(r.added.length, MAX_EXAM_FOCUSES);
		assert.equal(r.skipped.length, 3);
		assert.equal(parseExamPlan(r.text, "x.md").focuses.length, MAX_EXAM_FOCUSES);
	});
});
