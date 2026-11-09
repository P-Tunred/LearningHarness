/**
 * Open questions (fork addition, Paul 2026-11-09): which graded questions
 * stay open, how a re-ask closes one, the "worked through" rule for the
 * step he is on, and the tutor's open_questions / quiz.revisits seam.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LOW_CONFIDENCE, questionLedger } from "../src/core/open-questions.ts";
import { digestSession, summarizeExams } from "../src/core/brain-export.ts";
import { derivePlanStatusesLh } from "../src/core/contracts/plan.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { openQuestionsText, revisitsProblem } from "../src/agent/tools/open-questions.ts";
import { examTopicPromptNote, topicMissing, topicStatusText } from "../src/core/topic-status.ts";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-data");
const TEACH = JSON.parse(fs.readFileSync(path.join(GOLDEN, "chats", "chat_mv27rrra_feff23b6.json"), "utf-8")) as ChatRecord;

/** A quiz call + its answer, in the transcript's shapes (see the golden fixture). */
function qa(
	id: string,
	answer: { correct?: boolean; confidence?: number; dontKnow?: boolean; dismissed?: boolean },
	args: { nodeId?: string; revisits?: string; type?: string; tool?: string } = {},
	text = `Question ${id}?`,
) {
	const tool = args.tool ?? "quiz";
	const callArgs = tool === "probe"
		? { question: text }
		: { type: args.type ?? "check", nodeId: args.nodeId ?? "n1", question: text, ...(args.revisits ? { revisits: args.revisits } : {}) };
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: callArgs }] },
		{ role: "toolResult", toolCallId: id, toolName: tool, isError: false, details: { kind: "quiz", tool, questionText: text, answeredAt: "2026-11-08T10:00:00.000Z", ...answer } },
	];
}

describe("questionLedger", () => {
	it("opens don't-know, wrong and right-but-unsure answers; a sure right answer stays closed", () => {
		const l = questionLedger([
			...qa("a", { dontKnow: true }),
			...qa("b", { correct: false, confidence: 80 }),
			...qa("c", { correct: true, confidence: LOW_CONFIDENCE - 1 }),
			...qa("d", { correct: true, confidence: 90 }),
			...qa("e", { correct: true }),
			...qa("f", { correct: false, dismissed: true }),
		]);
		assert.deepEqual(l.open.map((q) => [q.id, q.reason]), [["a", "dontKnow"], ["b", "incorrect"], ["c", "lowConfidence"]]);
		assert.equal(l.questions, 5, "dismissed answers do not count");
		assert.equal(l.graded, 4);
		assert.equal(l.correct, 3);
		assert.equal(l.open[0]!.question, "Question a?");
		assert.equal(l.open[0]!.nodeId, "n1");
	});

	it("closes an open question only when the re-ask is answered right and sure", () => {
		const base = [...qa("a", { correct: false }), ...qa("b", { dontKnow: true })];
		const unsure = questionLedger([...base, ...qa("r1", { correct: true, confidence: 20 }, { revisits: "a" })]);
		assert.deepEqual(unsure.open.map((q) => [q.id, q.reason]), [["a", "lowConfidence"], ["b", "dontKnow"]], "unsure re-ask: still open, newest reason, no second entry");

		const wrong = questionLedger([...base, ...qa("r1", { correct: false }, { revisits: "b" })]);
		assert.deepEqual(wrong.open.map((q) => [q.id, q.reason]), [["a", "incorrect"], ["b", "incorrect"]]);

		const closed = questionLedger([...base, ...qa("r1", { correct: true, confidence: 70 }, { revisits: "a" })]);
		assert.deepEqual(closed.open.map((q) => q.id), ["b"]);

		const twice = questionLedger([...base, ...qa("r1", { correct: false }, { revisits: "a" }), ...qa("r2", { correct: true }, { revisits: "a" })]);
		assert.deepEqual(twice.open.map((q) => q.id), ["b"], "a later sure answer still closes it");
	});

	it("only checks count: predictions and probe questions neither grade nor open", () => {
		const l = questionLedger([
			...qa("p", { correct: false }, { type: "predict" }),
			...qa("pk", { dontKnow: true }, { type: "\"predict\"" }),
			...qa("pr", { correct: false }, { tool: "probe" }),
			...qa("c", { correct: true }),
			...qa("legacy", { correct: false }, { type: "" }),
		]);
		assert.deepEqual(l.open.map((q) => q.id), ["legacy"], "an untyped record counts as a check");
		assert.equal(l.graded, 2);
		assert.equal(l.correct, 1);
		assert.equal(l.questions, 5, "every answered question still counts as activity");
	});

	it("a re-ask replaces the original for understanding too", () => {
		const fixed = questionLedger([...qa("a", { correct: false }), ...qa("b", { correct: true }), ...qa("r", { correct: true, confidence: 80 }, { revisits: "a" })]);
		assert.equal(fixed.graded, 2, "a and its re-ask count once");
		assert.equal(fixed.correct, 2, "with the latest answer");
		const again = questionLedger([...qa("a", { dontKnow: true }), ...qa("r", { correct: false }, { revisits: "a" })]);
		assert.equal(again.graded, 1, "don't know → wrong: now graded, still open");
		assert.equal(again.correct, 0);
		assert.deepEqual(again.open.map((q) => [q.id, q.reason]), [["a", "incorrect"]]);
	});

	it("a re-ask of something not open is an ordinary question", () => {
		const l = questionLedger([...qa("a", { correct: true }), ...qa("r", { correct: false }, { revisits: "a" })]);
		assert.deepEqual(l.open.map((q) => q.id), ["r"]);
	});

	it("collects the plan nodes that have an answered question", () => {
		const l = questionLedger([...qa("a", { dontKnow: true }, { nodeId: "x" }), ...qa("b", { correct: true, dismissed: true }, { nodeId: "y" })]);
		assert.deepEqual([...l.answeredNodes], ["x"]);
	});

	it("on the golden session: same counts as before (no re-asks there)", () => {
		const d = digestSession(TEACH);
		const l = questionLedger(TEACH.messages);
		assert.equal(d.unsure.length, l.open.length);
		assert.ok(l.open.length > 0);
		assert.ok(l.open.every((q) => typeof q.id === "string" && q.id.length > 0));
	});
});

describe("worked through: the step he is on", () => {
	it("counts fully once a question on it was answered", () => {
		const s = derivePlanStatusesLh(TEACH.tree!, TEACH.messages as unknown as LhMessage[]);
		assert.ok(s.current, "the golden session stands on a node");
		const answered = questionLedger(TEACH.messages).answeredNodes.has(s.current!);
		const [exam] = summarizeExams(
			[{ exam: "Test", date: "2026-12-01", focuses: [{ title: "T", weight: null, chatId: TEACH.id }] }],
			[TEACH],
		);
		const expected = Math.round(Math.min(1, (s.visited.size + (answered ? 1 : 0.5)) / TEACH.tree!.nodes.length) * 10_000) / 10_000;
		assert.equal(exam!.focuses[0]!.progress, expected);
	});

	it("reaches 100 % when the last step's question is answered", () => {
		const chat = {
			...TEACH,
			id: "chat_full",
			tree: { nodes: [{ id: "n1", title: "One" }, { id: "n2", title: "Two" }], edges: [{ from: "n1", to: "n2" }] },
			messages: [{ role: "user", content: "hi" }, ...qa("a", { correct: true }, { nodeId: "n1" }), ...qa("b", { correct: true }, { nodeId: "n2" })],
		} as unknown as ChatRecord;
		const [exam] = summarizeExams([{ exam: "Test", date: "2026-12-01", focuses: [{ title: "T", weight: null, chatId: chat.id }] }], [chat]);
		assert.equal(exam!.focuses[0]!.progress, 1);
	});
});

describe("tutor seam", () => {
	const messages = [...qa("a", { correct: false }), ...qa("b", { correct: true, confidence: 10 })];
	const ctx = { chatId: "c1", chatStore: { getChat: () => ({ messages }) } } as never;

	it("open_questions lists id, text and why", () => {
		const out = JSON.parse(openQuestionsText(messages)) as { count: number; openQuestions: Array<{ id: string; why: string; nodeId?: string }> };
		assert.equal(out.count, 2);
		assert.deepEqual(out.openQuestions.map((q) => q.id), ["a", "b"]);
		assert.equal(out.openQuestions[0]!.why, "answered wrong");
		assert.equal(out.openQuestions[1]!.why, "answered right but unsure (confidence 10)");
		assert.equal(out.openQuestions[0]!.nodeId, "n1");
	});

	it("quiz.revisits must name an open question of this chat", () => {
		assert.equal(revisitsProblem(ctx, undefined), null);
		assert.equal(revisitsProblem(ctx, "a"), null);
		assert.match(revisitsProblem(ctx, "zzz") ?? "", /not an open question/);
	});
});

describe("topic status for the tutor", () => {
	const base = { exam: "FODS", topic: "PCA", workedThrough: 0.95, understood: 0.71, done: 0.6745, openQuestions: 4, finished: false };

	it("names what is missing in numbers", () => {
		const out = JSON.parse(topicStatusText(base)) as { finished: boolean; done: string; missing: string[] };
		assert.equal(out.finished, false);
		assert.equal(out.done, "67 %");
		assert.equal(out.missing.length, 3);
		assert.match(out.missing[0]!, /must reach 90 %/);
		assert.match(out.missing[2]!, /4 open questions/);
		assert.deepEqual(topicMissing({ ...base, done: 0.93, understood: 0.95, openQuestions: 0, finished: true }), []);
		assert.match(topicStatusText(null), /not a topic of an exam plan/);
	});

	it("the prompt note is stable text: topic, rule, and when to call topic_status", () => {
		const note = examTopicPromptNote("FODS", "PCA");
		assert.equal(note, examTopicPromptNote("FODS", "PCA"));
		assert.match(note, /"PCA" of the learner's exam plan "FODS"/);
		assert.match(note, /call topic_status/);
		assert.doesNotMatch(note, /\d+ open/, "no live numbers in the prompt");
	});

	it("topic_status is registered only in exam topic chats", async () => {
		const { createTeacherTools } = await import("../src/agent/tools.ts");
		const ctx = { chatId: "c1", chatStore: { getChat: () => ({ messages: [] }) }, jobStore: {}, spawn: () => {} } as never;
		assert.equal("topic_status" in createTeacherTools(ctx), false);
		assert.equal("topic_status" in createTeacherTools({ ...(ctx as object), topicStatus: () => base } as never), true);
	});
});
