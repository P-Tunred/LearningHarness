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

describe("naming and prompt", () => {
	it("matches focuses case- and space-insensitively", () => {
		assert.equal(focusKey("  Bias  Variance "), focusKey("bias variance"));
	});

	it("names the folder after the exam, without doubling the word Klausur", () => {
		assert.equal(examFolderName({ exam: "FODS" }), "FODS Klausur");
		assert.equal(examFolderName({ exam: "Statistik-Nachklausur" }), "Statistik-Nachklausur");
	});

	it("carries exam, focus, weight, body, context and the plan path", () => {
		const plan = parseExamPlan(PLAN, "fods");
		const prompt = openingPrompt(plan, plan.focuses[0]!, "/brain/LearnHarness/Auftraege/fods.md");
		assert.match(prompt, /^Klausurvorbereitung: FODS am 2026-11-20\.\nSchwerpunkt: Bias-Variance-Tradeoff \(Gewicht: hoch\)\./);
		assert.match(prompt, /Lecture05\.pdf/);
		assert.match(prompt, /Zur ganzen Klausur:\nSchriftlich/);
		assert.match(prompt, /`\/brain\/LearnHarness\/Auftraege\/fods\.md`/);
	});
});
