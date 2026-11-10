import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { questionLedger, type OpenQuestion } from "../../core/open-questions.ts";
import type { PlanToolContext } from "./plan.ts";

/**
 * open_questions (fork addition, Paul 2026-11-09) — SERVER-SIDE, read-only:
 * the open questions of THIS chat (answered "I don't know", wrong, or
 * right but unsure, and not since re-asked and answered right and sure).
 * Each carries the id the teach quiz's `revisits` field takes. Rules:
 * src/core/open-questions.ts. Mechanics only, like every tool description.
 */

const openQuestionsInput = Type.Object({});

const REASON_TEXT: Record<OpenQuestion["reason"], string> = {
	dontKnow: "answered I don't know",
	incorrect: "answered wrong",
	lowConfidence: "answered right but unsure",
};

/** The open questions of a chat, as the tool returns them (exported for tests). */
export function openQuestionsText(messages: readonly unknown[]): string {
	const open = questionLedger(messages).open;
	if (open.length === 0) return JSON.stringify({ count: 0, openQuestions: [] });
	return JSON.stringify({
		count: open.length,
		openQuestions: open.map((q) => ({
			id: q.id,
			question: q.question,
			why: REASON_TEXT[q.reason] + (q.confidence !== undefined ? ` (confidence ${q.confidence})` : ""),
			...(q.nodeId ? { nodeId: q.nodeId } : {}),
		})),
	});
}

// No call-time check on quiz.revisits (Paul, 2026-11-10: "it should not
// be like this" — every rejection was a "Retrying…"). The ledger resolves
// the id — exact, a re-ask's own id, or a mis-copied one (matchQuestionId)
// — and a right and sure answer closes the open question it names. An id
// that names no open question makes the quiz an ordinary new check.

export function openQuestionsTool(ctx: Pick<PlanToolContext, "chatId" | "chatStore">): AgentTool<typeof openQuestionsInput> {
	return {
		name: "open_questions",
		label: "open_questions",
		description:
			"List this session's open questions: graded questions the learner answered with I don't know, answered wrong, " +
			"or answered right but unsure — and has not since answered right and sure when re-asked. Each entry has an id, " +
			"the question text, why it is open, and its plan node. To re-ask one, pose a quiz with `revisits` set to its id " +
			"(same or reworded question); a right and confident answer closes it. Read-only; no arguments.",
		parameters: openQuestionsInput,
		execute: serverExecute("open_questions", openQuestionsInput, async () =>
			openQuestionsText(ctx.chatStore.getChat(ctx.chatId)?.messages ?? []),
		),
	};
}
