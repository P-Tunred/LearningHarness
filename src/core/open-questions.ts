/**
 * Open questions (fork addition) — PURE: which graded questions of a chat
 * are still open, and which plan nodes have an answered question.
 *
 * Why (Paul, 2026-11-09): the exam overview showed "29 open questions"
 * that he could not see anywhere and that never went away. Now:
 *  - Only CHECKS count (isCheck): predictions (guesses before a step is
 *    taught) and the probe's diagnostic questions are ignored for both
 *    understanding and open questions.
 *  - A check is OPEN when he answered "I don't know", answered wrong,
 *    or answered right but unsure (confidence below LOW_CONFIDENCE).
 *  - A RE-ASK (a quiz call carrying `revisits: <id>`, same or reworded)
 *    REPLACES the open check's result — for understanding too: a question
 *    counts once, with its latest answer. Right and sure closes it; wrong
 *    or unsure keeps it open with the newest reason.
 *  - The id of an open question is the tool call id of the question that
 *    first opened it — stable for the life of the chat.
 *
 * Read from the transcript alone: the question tool calls (assistant
 * messages) carry `nodeId`/`revisits`, the answers (tool results) carry
 * `questionText`, `correct`, `confidence`, `dontKnow`, `dismissed`.
 */

import { normalizeQuizType } from "./question-core.ts";

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
	/** A re-ask's own call id → the original question's id. The tutor may
	 *  name either when it re-asks again (it sees the newest call). */
	aliases: ReadonlyMap<string, string>;
}

interface Call {
	name: string;
	type?: unknown;
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
		for (const block of msg.content as Array<{ type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>) {
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			const args = (block.arguments ?? {}) as { type?: unknown; nodeId?: unknown; revisits?: unknown };
			const nodeId = text(args.nodeId);
			const revisits = text(args.revisits);
			calls.set(block.id, {
				name: typeof block.name === "string" ? block.name : "",
				type: args.type,
				...(nodeId ? { nodeId } : {}),
				...(revisits ? { revisits } : {}),
			});
		}
	}
	return calls;
}

/** A check's standing: its latest answer (a re-ask replaces the original). */
interface Item {
	id: string;
	question: string;
	nodeId?: string;
	/** null = not graded ("I don't know"). */
	correct: boolean | null;
	reason: OpenReason | null;
	confidence?: number;
	answeredAt?: string;
}

/** Only CHECKS measure understanding (Paul, 2026-11-09): teach-phase quiz
 *  or explain posed after the step was taught. Predictions (guesses before
 *  teaching) and the probe's diagnostic questions never count. Records
 *  without a `type` render as checks — the standing default. */
function isCheck(call: Call): boolean {
	return (call.name === "quiz" || call.name === "explain") && normalizeQuizType(call.type) !== "predict";
}

/** Below this many shared leading characters two ids are not "the same id". */
const MIN_ID_OVERLAP = 16;

/**
 * The real question id a model meant (Paul, 2026-11-10): models copy long
 * call ids imperfectly — "call_67441a23c7c04fa5ba75c308" came back with
 * "40" appended. An exact id wins; otherwise the ONE known id that the
 * given one extends, or that extends it, by a long shared start. null =
 * nothing, or more than one, fits. Exported for tests and the quiz check.
 */
export function matchQuestionId(given: string, known: Iterable<string>): string | null {
	const ids = [...known];
	if (ids.includes(given)) return given;
	const fits = ids.filter((k) => Math.min(k.length, given.length) >= MIN_ID_OVERLAP && (given.startsWith(k) || k.startsWith(given)));
	return fits.length === 1 ? fits[0]! : null;
}

export function questionLedger(messages: readonly unknown[]): QuestionLedger {
	const calls = questionCalls(messages);
	const items = new Map<string, Item>();
	const aliases = new Map<string, string>();
	const resolve = (raw: string) => {
		const id = matchQuestionId(raw, calls.keys()) ?? raw;
		return aliases.get(id) ?? id;
	};
	const answeredNodes = new Set<string>();
	let questions = 0;
	for (const m of messages) {
		const msg = m as { role?: unknown; details?: unknown; toolCallId?: unknown; toolName?: unknown };
		if (msg.role !== "toolResult" || !msg.details || typeof msg.details !== "object" || Array.isArray(msg.details)) continue;
		const d = msg.details as Answer;
		if (typeof d.questionText !== "string" || d.dismissed === true || d.kind === "ask") continue;
		questions++;
		const id = typeof msg.toolCallId === "string" ? msg.toolCallId : `q${questions}`;
		const call: Call = calls.get(id) ?? { name: typeof msg.toolName === "string" ? msg.toolName : "" };
		if (call.nodeId) answeredNodes.add(call.nodeId);
		if (!isCheck(call)) continue;
		const confidence = typeof d.confidence === "number" && Number.isFinite(d.confidence) ? d.confidence : undefined;
		let reason: OpenReason | null = null;
		let correct: boolean | null = null;
		if (d.dontKnow === true) reason = "dontKnow";
		else if (typeof d.correct === "boolean") {
			correct = d.correct;
			if (!d.correct) reason = "incorrect";
			else if (confidence !== undefined && confidence < LOW_CONFIDENCE) reason = "lowConfidence";
		} else continue; // ungraded (free recall): neither opens nor closes
		const answeredAt = text(d.answeredAt);
		const result = { correct, reason, ...(confidence !== undefined ? { confidence } : {}), ...(answeredAt ? { answeredAt } : {}) };
		// A re-ask of an open check REPLACES its result: the old answer no
		// longer counts, and a right and sure one closes it.
		const target = call.revisits ? items.get(resolve(call.revisits)) : undefined;
		if (target && target.reason !== null) {
			const { confidence: _c, answeredAt: _a, ...kept } = target;
			items.set(target.id, { ...kept, ...result, answeredAt: answeredAt ?? target.answeredAt });
			aliases.set(id, target.id);
			continue;
		}
		items.set(id, { id, question: d.questionText.trim(), ...(call.nodeId ? { nodeId: call.nodeId } : {}), ...result });
	}
	const all = [...items.values()];
	const open: OpenQuestion[] = all
		.filter((i): i is Item & { reason: OpenReason } => i.reason !== null)
		.map(({ id, question, reason, confidence, nodeId, answeredAt }) => ({
			id,
			question,
			reason,
			...(confidence !== undefined ? { confidence } : {}),
			...(nodeId ? { nodeId } : {}),
			...(answeredAt ? { answeredAt } : {}),
		}));
	return {
		questions,
		graded: all.filter((i) => i.correct !== null).length,
		correct: all.filter((i) => i.correct === true).length,
		open,
		answeredNodes,
		aliases,
	};
}
