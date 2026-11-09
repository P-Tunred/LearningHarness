/**
 * Fach-Überprüfung (fork addition) — the pure half: fach.md, the material
 * budget, the laws a run must keep (above all: no previous topic vanishes)
 * and plan.md / aenderungen.md.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildReviewPrompt,
	fillReview,
	fitMaterials,
	parseSubjectMeta,
	previousTopicTitles,
	renderChanges,
	renderPlan,
	validateReview,
	type ReviewResult,
	type Topic,
} from "../src/core/subject-review.ts";

const topic = (title: string, over: Partial<Topic> = {}): Topic => ({
	title, status: "active", weight: "medium", effortHours: 3, sources: ["Folien/W1.pdf"], prerequisites: [],
	examEvidence: "asked every year", learnerState: "not-started", goal: `Explain ${title}.`, note: "", ...over,
});
const result = (topics: Topic[], over: Partial<ReviewResult> = {}): ReviewResult => fillReview({ summary: "All good.", topics, ...over });

describe("parseSubjectMeta", () => {
	it("reads English and German keys and keeps the body as notes", () => {
		const m = parseSubjectMeta("---\nexam: Intro to ML\ndate: 2027-02-10\nhours_per_week: 8\nlanguage: English\n---\nOpen book exam.");
		assert.deepEqual(m, { exam: "Intro to ML", date: "2027-02-10", hoursPerWeek: 8, language: "English", notes: "Open book exam." });
		const de = parseSubjectMeta("---\nklausur: ML\ndatum: 2027-02-31\nstunden_pro_woche: 6,5\nsprache: Deutsch\n---\n");
		assert.equal(de.exam, "ML");
		assert.equal(de.date, null, "invalid date dropped");
		assert.equal(de.hoursPerWeek, 6.5);
		assert.deepEqual(parseSubjectMeta(null), { exam: null, date: null, hoursPerWeek: null, language: null, notes: "" });
	});
});

describe("fitMaterials", () => {
	it("keeps everything under the budget and cuts only the long files above it", () => {
		const mats = [
			{ kind: "exam" as const, name: "Klausuren/2024.pdf", text: "e".repeat(3_000) },
			{ kind: "slides" as const, name: "Folien/W1.pdf", text: "a".repeat(50_000) },
			{ kind: "slides" as const, name: "Folien/W2.pdf", text: "b".repeat(80_000) },
		];
		assert.ok(fitMaterials(mats, 1_000_000).every((m) => !m.cut));
		const fitted = fitMaterials(mats, 60_000);
		assert.equal(fitted[0]!.cut, false, "a short exam stays whole");
		assert.ok(fitted[1]!.cut && fitted[2]!.cut);
		const used = fitted.reduce((s, m) => s + m.text.replace(/\n\[… cut.*\]$/, "").length, 0);
		assert.ok(used <= 60_000 + 10, String(used));
	});
});

describe("validateReview — the plan accounts for itself", () => {
	it("accepts a plan that keeps or explains every previous topic", () => {
		const r = result([topic("Regression"), topic("Old trees", { status: "obsolete", note: "merged into Ensembles" }), topic("Ensembles", { prerequisites: ["Regression"] })], {
			changes: [{ kind: "renamed", topic: "Linear models", reason: "now called Regression" }],
		});
		assert.equal(validateReview(r, ["Linear models", "Old trees"]), null);
	});

	it("refuses a plan in which a previous topic silently disappears", () => {
		const problem = validateReview(result([topic("Regression")]), ["Regression", "Clustering"]);
		assert.match(problem ?? "", /missing: Clustering/);
	});

	it("refuses duplicates, unknown prerequisites, odd effort and an empty plan", () => {
		assert.match(validateReview(result([topic("A"), topic("a")]), []) ?? "", /Duplicate/);
		assert.match(validateReview(result([topic("A", { prerequisites: ["Z"] })]), []) ?? "", /prerequisites/);
		assert.match(validateReview(result([topic("A", { effortHours: 100 })]), []) ?? "", /effortHours/);
		assert.match(validateReview(result([topic("A", { status: "obsolete" })]), []) ?? "", /at least one active/);
	});
});

describe("plan.md and aenderungen.md", () => {
	const meta = parseSubjectMeta("---\nexam: ML Exam\ndate: 2027-02-10\n---\n");
	const r = result(
		[topic("Basics", { weight: "low" }), topic("Kernel methods", { weight: "high", learnerState: "shaky", prerequisites: ["Basics"], note: "you mixed up the kernel trick" }), topic("Perceptron", { status: "obsolete", note: "merged into Basics" })],
		{ changes: [{ kind: "added", topic: "Kernel methods", reason: "week 3 slides" }], conflicts: [{ topic: "Basics", description: "W1 and W2 define the margin differently", sources: ["Folien/W1.pdf", "Folien/W2.pdf"] }], openQuestions: ["Is the exam open book?"] },
	);
	const plan = renderPlan("ML", meta, r, "2026-11-09T10:00:00.000Z", 2);

	it("lists active topics most important first, and only they are '## ' sections", () => {
		assert.deepEqual(previousTopicTitles(plan), ["Kernel methods", "Basics"]);
		assert.match(plan, /^---\nklausur: ML Exam\ndatum: 2027-02-10\n/);
		assert.match(plan, /## Kernel methods\nGewicht: hoch\nAufwand: 3 h\nStand: wackelig\nVoraussetzungen: Basics/);
		assert.match(plan, /Hinweis: you mixed up the kernel trick/);
		assert.match(plan, /# Widersprüche in den Unterlagen\n- \*\*Basics\*\*: W1 and W2/);
		assert.match(plan, /# Überholte Themen\n- Perceptron: merged into Basics/);
	});

	it("puts the newest run on top of aenderungen.md and keeps the earlier ones", () => {
		const first = renderChanges(null, "ML", r, "2026-11-02T10:00:00.000Z", ["Folien/W1.pdf"]);
		const second = renderChanges(first, "ML", result([topic("Basics")]), "2026-11-09T10:00:00.000Z", ["Folien/W2.pdf"]);
		const runs = second.split("\n## ").slice(1).map((s) => s.slice(0, 16));
		assert.deepEqual(runs, ["2026-11-09 10:00", "2026-11-02 10:00"]);
		assert.match(second, /\*\*neu\*\*: Kernel methods — week 3 slides/);
		assert.equal((second.match(/^# ML: Änderungen/gm) ?? []).length, 1);
	});

	it("the prompt carries the previous plan, the record and both kinds of material", () => {
		const prompt = buildReviewPrompt({
			subject: "ML", meta, today: "2026-11-09", previousPlan: plan,
			learner: [{ title: "Kernel methods", minutes: 40, questions: 5, graded: 4, correct: 2, unsure: ["What does the kernel trick avoid?"], lastActive: "2026-11-08" }],
			materials: [{ kind: "slides", name: "Folien/W3.pdf", text: "Kernels…" }, { kind: "exam", name: "Klausuren/2024.pdf", text: "Task 1…" }],
		});
		assert.match(prompt, /Previous plan[\s\S]*## Kernel methods/);
		assert.match(prompt, /2\/4 graded answers right[\s\S]*kernel trick avoid/);
		assert.match(prompt, /Past exams[\s\S]*### Klausuren\/2024\.pdf[\s\S]*Lecture slides[\s\S]*### Folien\/W3\.pdf/);
		assert.match(prompt, /Exam date: 2027-02-10/);
	});
});

describe("Settings line for the Fach-Überprüfung", async () => {
	const { subjectLine } = await import("../components/settings/brain-section.tsx");
	it("says what is running, what changed and what failed", () => {
		assert.equal(subjectLine({ running: "ML", outcomes: [] }), "Überprüfe ML …");
		assert.equal(subjectLine({ running: null, outcomes: [] }), "Noch kein Fach angelegt.");
		assert.equal(
			subjectLine({ running: null, outcomes: [
				{ subject: "ML", status: "reviewed", topics: 7, newMaterials: ["Folien/W3.pdf"] },
				{ subject: "Stats", status: "failed", error: "no models" },
			] }),
			"ML: neu geplant (7 Themen, 1 neue Dateien) · Stats: Fehler – no models (nächster Start versucht es erneut)",
		);
	});
});
