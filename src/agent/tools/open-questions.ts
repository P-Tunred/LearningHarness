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

/** Ids of every tool call in the transcript (the questions among them). */
function questionCallIds(messages: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		const msg = m as { role?: unknown; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const b of msg.content as Array<{ type?: unknown; id?: unknown }>) {
			if (b?.type === "toolCall" && typeof b.id === "string") ids.add(b.id);
		}
	}
	return ids;
}

/** The `revisits` check the teach quiz chains after its own contract. */
export function revisitsProblem(ctx: Pick<PlanToolContext, "chatId" | "chatStore">, raw: string | undefined): string | null {
	// Models often fill an optional field with "" — that means "none", not
	// an id (it caused needless "Retrying…" rounds). The ledger trims too.
	const revisits = raw?.trim();
	if (!revisits) return null;
	const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
	const { open, aliases } = questionLedger(messages);
	// A re-ask's own id stands for the original (the tutor sees the newest call).
	const id = aliases.get(revisits) ?? revisits;
	if (open.some((q) => q.id === id)) return null;
	// Any other question of this chat (a prediction, a probe question, one
	// already closed) goes through as a NEW check — no retry for that
	// (Paul, 2026-11-09). Only an id that names nothing here is rejected.
	if (questionCallIds(messages).has(revisits)) return null;
	return (
		`revisits "${revisits}" names no question of this session. ` +
		(open.length > 0
			? `Copy an id from open_questions exactly (${open.slice(0, 3).map((q) => q.id).join(", ")}${open.length > 3 ? ", …" : ""}), or leave revisits out.`
			: "This session has no open questions — leave revisits out.")
	);
}

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
