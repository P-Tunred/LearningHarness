/**
 * Klausur-Aufträge (fork addition) — the pure half: parsing a plan Claude
 * wrote, focus identity, folder naming and the opening prompt.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExamPlanError, examFolderName, focusKey, openingPrompt, parseExamPlan } from "../src/core/exam-plan.ts";

const PLAN = [
	"---",
	"klausur: FODS",
	"datum: 2026-11-20",
	"---",
	"# FODS-Klausur",
	"Schriftlich, 3 Stunden, ein A4-Spickzettel erlaubt.",
	"",
	"## Bias-Variance-Tradeoff",
	"Gewicht: hoch",
	"Ziel: Fehlerzerlegung herleiten und an Lernkurven erkennen.",
	"Quellen: ~/Uni/FODS/Lecture05.pdf",
	"### Altklausuren",
	"Kam 2024 und 2025 dran.",
	"",
	"## Kreuzvalidierung",
	"Gewicht: mittel",
	"",
	"## bias-variance-tradeoff",
	"Duplikat, wird ignoriert.",
].join("\n");

describe("parseExamPlan", () => {
	const plan = parseExamPlan(PLAN, "fods");

	it("reads exam, date, shared context and one focus per ## heading", () => {
		assert.equal(plan.exam, "FODS");
		assert.equal(plan.date, "2026-11-20");
		assert.equal(plan.context, "Schriftlich, 3 Stunden, ein A4-Spickzettel erlaubt.");
		assert.deepEqual(plan.focuses.map((f) => f.title), ["Bias-Variance-Tradeoff", "Kreuzvalidierung"]);
	});

	it("takes the weight line out of the body and keeps ### subsections in it", () => {
		const [bias, cv] = plan.focuses;
		assert.equal(bias!.weight, "hoch");
		assert.equal(cv!.weight, "mittel");
		assert.doesNotMatch(bias!.body, /Gewicht/);
		assert.match(bias!.body, /### Altklausuren\nKam 2024/);
		assert.equal(cv!.body, "");
	});

	it("falls back to the file name and drops an invalid date or weight", () => {
		const p = parseExamPlan("---\ndatum: 2026-02-30\n---\n## Thema\nGewicht: sehr\nText", "km-klausur");
		assert.equal(p.exam, "km-klausur");
		assert.equal(p.date, null);
		assert.equal(p.focuses[0]!.weight, null);
		assert.match(p.focuses[0]!.body, /Gewicht: sehr/, "an unknown weight stays visible in the text");
	});

	it("refuses a plan without any focus", () => {
		assert.throws(() => parseExamPlan("---\nklausur: X\n---\nNur Text", "x"), ExamPlanError);
	});
});

describe("English plans and planning fields", () => {
	const EN = [
		"---", "exam: FODS Theory Exam", "date: 2026-12-09", "hours_per_week: 14", "review_from: 2026-11-26", "---",
		"## Decision trees", "Weight: high", "Effort: 7 h", "Goal: compute information gain.",
		"## Distances", "Weight: medium", "Effort: 3,5 hours",
		"## Odd one", "Weight: urgent", "Effort: lots",
	].join("\n");
	const plan = parseExamPlan(EN, "x");

	it("reads English keys, weights and effort", () => {
		assert.equal(plan.exam, "FODS Theory Exam");
		assert.equal(plan.date, "2026-12-09");
		assert.equal(plan.hoursPerWeek, 14);
		assert.equal(plan.reviewFrom, "2026-11-26");
		assert.deepEqual(plan.focuses.map((f) => [f.weight, f.effortHours]), [["hoch", 7], ["mittel", 3.5], [null, null]]);
	});

	it("keeps the effort line in the text, and an unknown weight too", () => {
		assert.match(plan.focuses[0]!.body, /^Effort: 7 h/);
		assert.match(plan.focuses[2]!.body, /Weight: urgent/);
	});

	it("reads the German planning keys as well", () => {
		const de = parseExamPlan("---\nklausur: X\nstunden_pro_woche: 10\nwiederholung_ab: 2026-11-20\n---\n## A\nAufwand: 2 h", "x");
		assert.equal(de.hoursPerWeek, 10);
		assert.equal(de.reviewFrom, "2026-11-20");
		assert.equal(de.focuses[0]!.effortHours, 2);
	});
});

describe("naming and prompt", () => {
	it("matches focuses case- and space-insensitively", () => {
		assert.equal(focusKey("  Bias  Variance "), focusKey("bias variance"));
	});

	it("names the folder after the exam, without doubling the word Klausur", () => {
		assert.equal(examFolderName({ exam: "FODS" }), "FODS Klausur");
		assert.equal(examFolderName({ exam: "Statistik-Nachklausur" }), "Statistik-Nachklausur");
	});

	it("names the folder after an English exam name as it is", () => {
		assert.equal(examFolderName({ exam: "FODS Theory Exam" }), "FODS Theory Exam");
	});

	it("writes the opening prompt in English with exam, focus, weight, body, context and plan path", () => {
		const plan = parseExamPlan(PLAN, "fods");
		const prompt = openingPrompt(plan, plan.focuses[0]!, "/brain/LearnHarness/Auftraege/fods.md");
		assert.match(prompt, /^Exam preparation: FODS on 2026-11-20\.\nFocus: Bias-Variance-Tradeoff \(weight: high\)\./);
		assert.match(prompt, /Lecture05\.pdf/);
		assert.match(prompt, /About the whole exam:\nSchriftlich/);
		assert.match(prompt, /`\/brain\/LearnHarness\/Auftraege\/fods\.md`/);
		assert.match(prompt, /Teach me in English\./);
	});
});
