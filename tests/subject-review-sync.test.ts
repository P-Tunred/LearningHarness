/**
 * Fach-Überprüfung (fork addition) — the IO half against real files: a
 * temp data dir (LH_DATA_DIR seam, set before any store import) and a temp
 * brain with one subject. The model is replaced by a recording reviewer.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-faecher-data-"));
process.env.LH_DATA_DIR = DATA;
const BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "lh-faecher-brain-"));
const SUBJECT = path.join(BRAIN, "LearnHarness", "Faecher", "ML");

function put(rel: string, content: string | Buffer) {
	const file = path.join(SUBJECT, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}
put("fach.md", "---\nexam: ML Exam\ndate: 2027-02-10\n---\nOpen book.");
put("Folien/Woche 01.md", "# Week 1\nLinear regression, least squares.");
put("Folien/Woche 02.pdf", fs.readFileSync(path.join(HERE, "fixtures", "sample-3page.pdf")));
put("Klausuren/2024.md", "Task 1 (20 points): derive least squares.");

const { reviewSubjects, listSubjects, SUBJECT_STATE_FILE } = await import("../src/server/subject-review.ts");
type Reviewer = Parameters<typeof reviewSubjects>[1] extends infer O ? O extends { reviewer?: infer R } ? NonNullable<R> : never : never;
type Topic = Awaited<ReturnType<Reviewer>>["topics"][number];

const topic = (title: string, over: Partial<Topic> = {}): Topic => ({
	title, status: "active", weight: "high", effortHours: 3, sources: ["Folien/Woche 01.md"], prerequisites: [],
	examEvidence: "Task 1, 20 points", learnerState: "not-started", goal: `Master ${title}.`, note: "", ...over,
});

const calls: Array<{ input: Parameters<Reviewer>[0]; previousTitles: string[] }> = [];
let answer: (input: Parameters<Reviewer>[0]) => Awaited<ReturnType<Reviewer>> = () => ({
	summary: "First plan.", topics: [topic("Least squares"), topic("Regularization", { weight: "medium" })],
	changes: [{ kind: "added", topic: "Least squares", reason: "week 1" }], conflicts: [], openQuestions: [],
});
const reviewer: Reviewer = async (input, previousTitles) => {
	calls.push({ input, previousTitles });
	return answer(input);
};
const NOW = new Date("2026-11-09T10:00:00Z");
const read = (rel: string) => fs.readFileSync(path.join(SUBJECT, rel), "utf-8");

describe("Fach-Überprüfung", () => {
	it("finds the subject and reviews it once: plan.md, aenderungen.md, state", async () => {
		assert.deepEqual(listSubjects(BRAIN), ["ML"]);
		const out = await reviewSubjects(BRAIN, { reviewer, now: NOW });
		assert.deepEqual(out.map((o) => [o.subject, o.status, o.topics]), [["ML", "reviewed", 2]]);
		const input = calls[0]!.input;
		assert.equal(input.meta.exam, "ML Exam");
		assert.deepEqual(input.materials.map((m) => [m.kind, m.name]), [
			["slides", "Folien/Woche 01.md"], ["slides", "Folien/Woche 02.pdf"], ["exam", "Klausuren/2024.md"],
		]);
		assert.match(input.materials[1]!.text, /--- Page 1 ---/, "the PDF arrives as text");
		assert.equal(input.previousPlan, null);
		assert.match(read("plan.md"), /^---\nklausur: ML Exam\ndatum: 2027-02-10\n[\s\S]*## Least squares\nGewicht: hoch/);
		assert.match(read("aenderungen.md"), /Neu dazugekommen: Folien\/Woche 01\.md, Folien\/Woche 02\.pdf, Klausuren\/2024\.md/);
		const state = JSON.parse(fs.readFileSync(SUBJECT_STATE_FILE, "utf-8"));
		assert.equal(state.subjects.ML.run, 1);
		assert.ok(fs.readdirSync(path.join(DATA, "faecher-cache")).some((f) => f.endsWith(".md")), "PDF text cached");
	});

	it("does not run again while nothing changed", async () => {
		const out = await reviewSubjects(BRAIN, { reviewer, now: NOW });
		assert.equal(out[0]!.status, "unchanged");
		assert.equal(calls.length, 1);
	});

	it("new slides: runs again from the previous plan (with Paul's edits) and must keep its topics", async () => {
		// Paul edited the plan by hand.
		fs.writeFileSync(path.join(SUBJECT, "plan.md"), read("plan.md").replace("## Regularization", "## Regularization\nPaul: lecturer said this is key"));
		put("Folien/Woche 03.md", "# Week 3\nRidge and lasso.");
		answer = () => ({
			summary: "Week 3 deepens regularization.",
			topics: [topic("Least squares"), topic("Ridge & Lasso", { prerequisites: ["Least squares"] })],
			changes: [{ kind: "renamed", topic: "Regularization", reason: "week 3 names it Ridge & Lasso" }],
			conflicts: [], openQuestions: [],
		});
		const out = await reviewSubjects(BRAIN, { reviewer, now: new Date("2026-11-16T10:00:00Z") });
		assert.equal(out[0]!.status, "reviewed");
		assert.deepEqual(out[0]!.newMaterials, ["Folien/Woche 03.md"]);
		const call = calls[1]!;
		assert.deepEqual(call.previousTitles, ["Least squares", "Regularization"]);
		assert.match(call.input.previousPlan ?? "", /lecturer said this is key/, "his edit reaches the model");
		const changes = read("aenderungen.md");
		assert.ok(changes.indexOf("2026-11-16") < changes.indexOf("2026-11-09"), "newest run on top");
		assert.match(changes, /\*\*umbenannt\*\*: Regularization/);
	});

	it("a run that drops a previous topic is refused: plan.md stays, the next start retries", async () => {
		const before = read("plan.md");
		put("Folien/Woche 04.md", "# Week 4\nTrees.");
		answer = () => ({ summary: "Trees.", topics: [topic("Trees")], changes: [], conflicts: [], openQuestions: [] });
		const out = await reviewSubjects(BRAIN, { reviewer, now: new Date("2026-11-23T10:00:00Z") });
		assert.equal(out[0]!.status, "failed");
		assert.match(out[0]!.error ?? "", /missing: Least squares, Ridge & Lasso/);
		assert.equal(read("plan.md"), before);
		answer = () => ({ summary: "Trees added.", topics: [topic("Least squares"), topic("Ridge & Lasso"), topic("Trees")], changes: [{ kind: "added", topic: "Trees", reason: "week 4" }], conflicts: [], openQuestions: [] });
		const retry = await reviewSubjects(BRAIN, { reviewer, now: new Date("2026-11-23T11:00:00Z") });
		assert.equal(retry[0]!.status, "reviewed");
		assert.deepEqual(retry[0]!.newMaterials, ["Folien/Woche 04.md"], "the failed run did not swallow the new file");
	});
});
