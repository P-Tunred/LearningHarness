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
 * Format (German keys shown; English works too: exam, date, hours_per_week,
 * review_from, "Weight: high|medium|low", "Effort: 4 h"):
 *   ---
 *   klausur: FODS
 *   datum: 2026-11-20
 *   stunden_pro_woche: 14       (optional, for the progress planner)
 *   wiederholung_ab: 2026-11-26 (optional; default: 14 days before)
 *   ---
 *   # FODS-Klausur            (optional)
 *   Context for every session (exam form, allowed aids, …)   (optional)
 *   ## Bias-Variance-Tradeoff
 *   Gewicht: hoch            (optional: hoch | mittel | niedrig)
 *   Aufwand: 4 h             (optional, hours; stays in the text too)
 *   Goal, sources, past-paper hints — passed on verbatim.
 */

export const EXAM_PLANS_DIR = "LearnHarness/Auftraege";
export const EXAM_WEIGHTS = ["hoch", "mittel", "niedrig"] as const;
export type ExamWeight = (typeof EXAM_WEIGHTS)[number];
/** English weight words map onto the German ones the exports use. */
const WEIGHT_ALIASES: Record<string, ExamWeight> = {
	hoch: "hoch", mittel: "mittel", niedrig: "niedrig",
	high: "hoch", medium: "mittel", low: "niedrig",
};

/** Upper bounds so a malformed plan cannot flood the sidebar or a prompt. */
const MAX_FOCUSES = 20;
const MAX_TITLE = 120;
const MAX_TEXT = 6_000;

export interface ExamFocus {
	title: string;
	weight: ExamWeight | null;
	/** Estimated hours from an `Aufwand:` line, or null. */
	effortHours: number | null;
	/** The focus's own text (goal, sources), verbatim minus the weight line. */
	body: string;
}

export interface ExamPlan {
	exam: string;
	/** YYYY-MM-DD, or null when the plan names no (valid) date. */
	date: string | null;
	/** Planned study hours per week (`stunden_pro_woche`), or null. */
	hoursPerWeek: number | null;
	/** First day of the review phase (`wiederholung_ab`), or null. */
	reviewFrom: string | null;
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

/** A positive number with optional "h" and a German decimal comma; null otherwise. */
function hours(value: string | undefined): number | null {
	const m = /^\s*(\d+(?:[.,]\d+)?)\s*(?:h|std|stunden|hours?)?\s*$/i.exec(value ?? "");
	if (!m) return null;
	const n = Number(m[1]!.replace(",", "."));
	return n > 0 && n <= 500 ? n : null;
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
			const w = /^\s*(?:gewicht|weight)\s*:\s*(\S+)/i.exec(line);
			if (!w || weight) return true;
			// An unknown weight stays in the text, so it is not silently lost.
			const value = WEIGHT_ALIASES[w[1]!.toLowerCase()];
			if (!value) return true;
			weight = value;
			return false;
		});
		const effort = lines.map((line) => /^\s*(?:aufwand|effort)\s*:\s*(.+)$/i.exec(line)?.[1]).find((v) => v !== undefined);
		focuses.push({ title: clip(current.title, MAX_TITLE), weight, effortHours: hours(effort), body: clip(lines.join("\n").trim(), MAX_TEXT) });
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
		hoursPerWeek: hours(meta.stunden_pro_woche ?? meta.hours_per_week),
		reviewFrom: validDate(meta.wiederholung_ab ?? meta.review_from),
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
	return /klausur|exam/i.test(plan.exam) ? plan.exam : `${plan.exam} Klausur`;
}

/** The first message of a focus session — sent when Paul opens it. English
 *  on purpose (Paul, 2026-10-31): the exams are in English, so is the lesson. */
export function openingPrompt(plan: ExamPlan, focus: ExamFocus, planPath: string): string {
	const when = plan.date ? ` on ${plan.date}` : "";
	const lines = [
		`Exam preparation: ${plan.exam}${when}.`,
		`Focus: ${focus.title}${focus.weight ? ` (weight: ${focus.weight === "hoch" ? "high" : focus.weight === "mittel" ? "medium" : "low"})` : ""}.`,
		"",
	];
	if (focus.body) lines.push(focus.body, "");
	if (plan.context) lines.push("About the whole exam:", plan.context, "");
	lines.push(
		`The full plan is in \`${planPath}\`. Teach me in English. Find out what I already know, read the listed sources and research what is missing — then get me exam-ready on this focus.`,
	);
	return lines.join("\n").trim();
}
