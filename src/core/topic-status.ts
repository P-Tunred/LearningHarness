/**
 * Exam topic status for the tutor (fork addition, Paul 2026-11-09) — PURE.
 *
 * Why: the tutor told Paul "this focus is done" while the exam overview
 * still said In progress. The tutor judged by its own lesson plan; the
 * overview by its rule (src/core/exam-progress.ts isFinished): worked
 * through × understood ≥ 90 % and no open questions. Now, in a chat that
 * is a topic of an exam plan, the tutor's prompt names the topic and the
 * rule (a STABLE note — the prompt cache stays warm), and the tool
 * topic_status gives the live numbers.
 */

import { UNDERSTANDING_TARGET } from "./exam-progress.ts";

/** The share of the topic that must be done (as isFinished). */
export const TOPIC_FINISHED_AT = 0.9;

export interface TopicStatus {
	exam: string;
	topic: string;
	/** 0…1 */
	workedThrough: number;
	/** 0…1; null below 3 graded checks. */
	understood: number | null;
	/** workedThrough × understood, 0…1 */
	done: number;
	openQuestions: number;
	finished: boolean;
}

const pct = (n: number) => `${Math.round(n * 100)} %`;

/** What still stands between the topic and "finished", in words. */
export function topicMissing(s: TopicStatus): string[] {
	if (s.finished) return [];
	const out: string[] = [];
	if (s.done < TOPIC_FINISHED_AT) {
		out.push(`done is ${pct(s.done)} (worked through ${pct(s.workedThrough)} × understood ${s.understood === null ? "not measurable yet" : pct(s.understood)}); it must reach ${pct(TOPIC_FINISHED_AT)}`);
	}
	if (s.understood !== null && s.understood < UNDERSTANDING_TARGET) {
		out.push(`understood is ${pct(s.understood)}, below the ${pct(UNDERSTANDING_TARGET)} target`);
	}
	if (s.openQuestions > 0) out.push(`${s.openQuestions} open ${s.openQuestions === 1 ? "question" : "questions"} remain`);
	return out;
}

/** The tool's answer (JSON text). */
export function topicStatusText(s: TopicStatus | null): string {
	if (!s) return JSON.stringify({ examTopic: false, note: "This session is not a topic of an exam plan (or the plan is not readable right now)." });
	return JSON.stringify({
		exam: s.exam,
		topic: s.topic,
		workedThrough: pct(s.workedThrough),
		understood: s.understood === null ? "not measurable yet (fewer than 3 graded checks)" : pct(s.understood),
		understoodTarget: pct(UNDERSTANDING_TARGET),
		done: pct(s.done),
		openQuestions: s.openQuestions,
		finished: s.finished,
		missing: topicMissing(s),
	});
}

/** The stable prompt note for an exam topic chat (no numbers: they change
 *  every turn and would break the prompt cache). */
export function examTopicPromptNote(exam: string, topic: string): string {
	return [
		"## Exam topic",
		`This session is the topic "${topic}" of the learner's exam plan "${exam}". LearnHarness counts the topic as FINISHED only when ` +
			`worked through × understood ≥ ${pct(TOPIC_FINISHED_AT)} and no open questions remain. Understood = the share of right answers to ` +
			"check questions (predictions and probe questions do not count; a re-asked open question counts with its latest answer). " +
			"Open = check questions answered wrong, with I don't know, or right but unsure — until re-asked and answered right and sure.",
		"While teaching: before you tell the learner that the topic, focus or session is done or finished, call topic_status. If it is " +
			"not finished, do not call it done — say in numbers what is still missing and offer to work on it (for open questions: list " +
			"them and re-ask them).",
	].join("\n");
}
