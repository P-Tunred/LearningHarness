/**
 * Open questions (fork addition) — PURE: which graded questions of a chat
 * are still open, and which plan nodes have an answered question.
 *
 * Why (Paul, 2026-11-09): the exam overview showed "29 open questions"
 * that he could not see anywhere and that never went away. Now:
 *  - A question is OPEN when he answered "I don't know", answered wrong,
 *    or answered right but unsure (confidence below LOW_CONFIDENCE).
 *  - It CLOSES only when the tutor re-asks it (a quiz call carrying
 *    `revisits: <id>`, same or reworded) and he answers right and sure.
 *    A revisit answered wrong or unsure keeps the original open (with the
 *    newest reason) and adds no second entry for the same gap.
 *  - The id of an open question is the tool call id of the question that
 *    first opened it — stable for the life of the chat.
 *
 * Read from the transcript alone: the question tool calls (assistant
 * messages) carry `nodeId`/`revisits`, the answers (tool results) carry
 * `questionText`, `correct`, `confidence`, `dontKnow`, `dismissed`.
 */

/** Below this self-reported confidence a correct answer still counts as unsure. */
export const LOW_CONFIDENCE = 50;

export type OpenReason = "dontKnow" | "incorrect" | "lowConfidence";

export interface OpenQuestion {
	/** The tool call id of the question that opened it. */
	id: string;
	question: string;
	reason: OpenReason;
	confidence?: number;
	/** The plan node the question was about, when it named one. */
	nodeId?: string;
	/** When it was last answered (ISO), when the answer carries it. */
	answeredAt?: string;
}

export interface QuestionLedger {
	/** Answered (not dismissed) questions, "ask" excluded. */
	questions: number;
	graded: number;
	correct: number;
	/** Still open, oldest first. */
	open: OpenQuestion[];
	/** Plan nodes with at least one answered question (any answer). */
	answeredNodes: Set<string>;
}

interface Call {
	nodeId?: string;
	revisits?: string;
}

interface Answer {
	kind?: unknown;
	questionText?: unknown;
	correct?: unknown;
	confidence?: unknown;
	dontKnow?: unknown;
	dismissed?: unknown;
	answeredAt?: unknown;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Every question tool call of the transcript, by id. */
function questionCalls(messages: readonly unknown[]): Map<string, Call> {
	const calls = new Map<string, Call>();
	for (const m of messages) {
		const msg = m as { role?: unknown; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content as Array<{ type?: unknown; id?: unknown; arguments?: unknown }>) {
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			const args = (block.arguments ?? {}) as { nodeId?: unknown; revisits?: unknown };
			const nodeId = text(args.nodeId);
			const revisits = text(args.revisits);
			calls.set(block.id, { ...(nodeId ? { nodeId } : {}), ...(revisits ? { revisits } : {}) });
		}
	}
	return calls;
}

export function questionLedger(messages: readonly unknown[]): QuestionLedger {
	const calls = questionCalls(messages);
	const open = new Map<string, OpenQuestion>();
	const answeredNodes = new Set<string>();
	let questions = 0;
	let graded = 0;
	let correct = 0;
	for (const m of messages) {
		const msg = m as { role?: unknown; details?: unknown; toolCallId?: unknown };
		if (msg.role !== "toolResult" || !msg.details || typeof msg.details !== "object" || Array.isArray(msg.details)) continue;
		const d = msg.details as Answer;
		if (typeof d.questionText !== "string" || d.dismissed === true || d.kind === "ask") continue;
		questions++;
		const id = typeof msg.toolCallId === "string" ? msg.toolCallId : `q${questions}`;
		const call = calls.get(id) ?? {};
		if (call.nodeId) answeredNodes.add(call.nodeId);
		const confidence = typeof d.confidence === "number" && Number.isFinite(d.confidence) ? d.confidence : undefined;
		let reason: OpenReason | null = null;
		if (d.dontKnow === true) reason = "dontKnow";
		else if (typeof d.correct === "boolean") {
			graded++;
			if (d.correct) correct++;
			if (!d.correct) reason = "incorrect";
			else if (confidence !== undefined && confidence < LOW_CONFIDENCE) reason = "lowConfidence";
		} else continue; // ungraded (free recall): neither opens nor closes
		const answeredAt = text(d.answeredAt);
		const target = call.revisits && open.has(call.revisits) ? open.get(call.revisits)! : null;
		if (target) {
			if (reason === null) open.delete(target.id);
			else {
				target.reason = reason;
				if (confidence !== undefined) target.confidence = confidence;
				else delete target.confidence;
				if (answeredAt) target.answeredAt = answeredAt;
			}
			continue;
		}
		if (reason === null) continue;
		open.set(id, {
			id,
			question: d.questionText.trim(),
			reason,
			...(confidence !== undefined ? { confidence } : {}),
			...(call.nodeId ? { nodeId: call.nodeId } : {}),
			...(answeredAt ? { answeredAt } : {}),
		});
	}
	return { questions, graded, correct, open: [...open.values()], answeredNodes };
}
