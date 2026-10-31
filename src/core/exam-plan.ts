/**
 * Klausur-Aufträge (fork addition) — PURE: a Markdown exam plan in, the
 * sessions it asks for out. No IO; src/server/exam-plans.ts reads the
 * files, creates the sessions and remembers what it created.
 *
 * Paul plans an exam with Claude (who has his brain, past papers and
 * lecture files); Claude writes the plan into
 * `<brain>/LearnHarness/Auftraege/<name>.md`. LearnHarness turns every
 * `## Schwerpunkt` into one teaching session inside a folder
 * "<Klausur> Klausur". The session's opening prompt is the plan's text
 * for that focus; it is sent when Paul first opens the session — nothing
 * runs (or bills) in the background.
 *
 * Format:
 *   ---
 *   klausur: FODS
 *   datum: 2026-11-20
 *   ---
 *   # FODS-Klausur            (optional)
 *   Context for every session (exam form, allowed aids, …)   (optional)
 *   ## Bias-Variance-Tradeoff
 *   Gewicht: hoch            (optional: hoch | mittel | niedrig)
 *   Goal, sources, past-paper hints — passed on verbatim.
 */

export const EXAM_PLANS_DIR = "LearnHarness/Auftraege";
export const EXAM_WEIGHTS = ["hoch", "mittel", "niedrig"] as const;
export type ExamWeight = (typeof EXAM_WEIGHTS)[number];

/** Upper bounds so a malformed plan cannot flood the sidebar or a prompt. */
const MAX_FOCUSES = 20;
const MAX_TITLE = 120;
const MAX_TEXT = 6_000;

export interface ExamFocus {
	title: string;
	weight: ExamWeight | null;
	/** The focus's own text (goal, sources), verbatim minus the weight line. */
	body: string;
}

export interface ExamPlan {
	exam: string;
	/** YYYY-MM-DD, or null when the plan names no (valid) date. */
	date: string | null;
	/** Text between the title and the first focus; shared by every session. */
	context: string;
	focuses: ExamFocus[];
}

export class ExamPlanError extends Error {}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function frontMatter(text: string): { meta: Record<string, string>; rest: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return { meta: {}, rest: text };
	const meta: Record<string, string> = {};
	for (const line of m[1]!.split(/\r?\n/)) {
		const kv = /^\s*([A-Za-zÄÖÜäöü_-]+)\s*:\s*(.*?)\s*$/.exec(line);
		if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, "");
	}
	return { meta, rest: text.slice(m[0].length) };
}

function validDate(value: string | undefined): string | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const d = new Date(`${value}T12:00:00Z`);
	return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

/** Parse a plan. `fallbackName` (the file name) names an exam without `klausur:`. */
export function parseExamPlan(text: string, fallbackName: string): ExamPlan {
	const { meta, rest } = frontMatter(text.replace(/^﻿/, ""));
	const exam = clip((meta.klausur ?? meta.exam ?? fallbackName).trim(), MAX_TITLE);
	if (!exam) throw new ExamPlanError("Der Auftrag nennt keine Klausur.");

	const focuses: ExamFocus[] = [];
	const contextLines: string[] = [];
	let current: { title: string; lines: string[] } | null = null;
	const flush = () => {
		if (!current) return;
		let weight: ExamWeight | null = null;
		const lines = current.lines.filter((line) => {
			const w = /^\s*gewicht\s*:\s*(\S+)/i.exec(line);
			if (!w || weight) return true;
			const value = w[1]!.toLowerCase();
			// An unknown weight stays in the text, so it is not silently lost.
			if (!(EXAM_WEIGHTS as readonly string[]).includes(value)) return true;
			weight = value as ExamWeight;
			return false;
		});
		focuses.push({ title: clip(current.title, MAX_TITLE), weight, body: clip(lines.join("\n").trim(), MAX_TEXT) });
	};
	for (const line of rest.split(/\r?\n/)) {
		const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
		if (h2 && !line.startsWith("###")) {
			flush();
			current = { title: h2[1]!.trim(), lines: [] };
		} else if (current) {
			current.lines.push(line);
		} else if (!/^#\s/.test(line)) {
			contextLines.push(line);
		}
	}
	flush();

	const seen = new Set<string>();
	const unique = focuses.filter((f) => {
		const key = focusKey(f.title);
		if (!f.title || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (unique.length === 0) throw new ExamPlanError("Der Auftrag hat keinen Schwerpunkt (## Überschrift).");
	if (unique.length > MAX_FOCUSES) throw new ExamPlanError(`Zu viele Schwerpunkte (${unique.length}), höchstens ${MAX_FOCUSES}.`);
	return {
		exam,
		date: validDate(meta.datum ?? meta.date),
		context: clip(contextLines.join("\n").trim(), MAX_TEXT),
		focuses: unique,
	};
}

/** Stable identity of a focus inside its plan (re-reads match by this). */
export function focusKey(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The folder the plan's sessions live in. */
export function examFolderName(plan: Pick<ExamPlan, "exam">): string {
	return /klausur/i.test(plan.exam) ? plan.exam : `${plan.exam} Klausur`;
}

/** The first message of a focus session — sent when Paul opens it. */
export function openingPrompt(plan: ExamPlan, focus: ExamFocus, planPath: string): string {
	const when = plan.date ? ` am ${plan.date}` : "";
	const lines = [
		`Klausurvorbereitung: ${plan.exam}${when}.`,
		`Schwerpunkt: ${focus.title}${focus.weight ? ` (Gewicht: ${focus.weight})` : ""}.`,
		"",
	];
	if (focus.body) lines.push(focus.body, "");
	if (plan.context) lines.push("Zur ganzen Klausur:", plan.context, "");
	lines.push(
		`Der ganze Plan steht in \`${planPath}\`. Finde heraus, was ich davon schon kann, lies die genannten Quellen und recherchiere, was fehlt — dann bring mich klausurfest an diesen Schwerpunkt.`,
	);
	return lines.join("\n").trim();
}
