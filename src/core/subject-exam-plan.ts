/**
 * From a subject's plan to its exam sessions (fork addition, Paul
 * 2026-11-11 — "Etappe 2" of the Fach-Überprüfung, FORK.md §3).
 *
 * The subject review keeps plan.md current: a new lecture can bring a new
 * topic. An exam plan in Auftraege/ that names its subject in the front
 * matter (`fach: IntSec`) opts in: every ACTIVE topic of that subject that
 * the exam plan does not have yet is appended as a new "## " section, and
 * the next exam-plan sync gives it its own session.
 *
 * Append only. Existing sections are never rewritten, reordered or removed:
 * their sessions exist, Paul may have edited the text, and a changed title
 * would read as a new topic and duplicate the session. A topic the review
 * renamed therefore arrives as a new section — the old one stays, and Paul
 * removes it by hand if he wants.
 */

import { focusKey } from "./exam-plan.ts";
import type { Topic } from "./subject-review.ts";

const WEIGHT_DE: Record<Topic["weight"], string> = { high: "hoch", medium: "mittel", low: "niedrig" };
const WEIGHT_RANK: Record<Topic["weight"], number> = { high: 0, medium: 1, low: 2 };
/** parseExamPlan refuses more than this many focuses; never append past it. */
export const MAX_EXAM_FOCUSES = 20;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Low-weight topics wait this many prerequisite steps longer. */
const LOW_WEIGHT_DELAY = 3;

/** Learning order: a topic after its prerequisites. Among the ready ones,
 *  the one that builds on the fewest topics comes first (so a capstone
 *  like "past-exam training", which builds on almost everything, comes
 *  last — 2026-11-11 it came 11th of 16 when weight decided), low weight
 *  waits a little, then heavier first, then the review's own order.
 *  Cycles cannot stall it. */
export function learningOrder(topics: readonly Topic[]): Topic[] {
	const active = topics.filter((t) => t.status === "active");
	const byKey = new Map(active.map((t) => [focusKey(t.title), t]));
	const depends = new Map<string, number>();
	const reach = (t: Topic): Set<string> => {
		const seen = new Set<string>();
		const walk = (x: Topic) => {
			for (const p of x.prerequisites) {
				const k = focusKey(p);
				const q = byKey.get(k);
				if (!q || seen.has(k)) continue;
				seen.add(k);
				walk(q);
			}
		};
		walk(t);
		return seen;
	};
	for (const t of active) depends.set(focusKey(t.title), reach(t).size + (t.weight === "low" ? LOW_WEIGHT_DELAY : 0));
	const rank = (t: Topic) => depends.get(focusKey(t.title))!;
	const placed = new Set<string>();
	const out: Topic[] = [];
	while (out.length < active.length) {
		const ready = active.filter(
			(t) => !placed.has(focusKey(t.title)) && t.prerequisites.every((p) => !byKey.has(focusKey(p)) || placed.has(focusKey(p))),
		);
		const pool = ready.length ? ready : active.filter((t) => !placed.has(focusKey(t.title)));
		const next = [...pool].sort(
			(a, b) => rank(a) - rank(b) || WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight] || active.indexOf(a) - active.indexOf(b),
		)[0]!;
		placed.add(focusKey(next.title));
		out.push(next);
	}
	return out;
}

/** One exam-plan section for a topic: what its session is told. */
export function topicSection(t: Topic): string {
	const lines = [
		`## ${oneLine(t.title)}`,
		`Gewicht: ${WEIGHT_DE[t.weight]}`,
		`Aufwand: ${t.effortHours} h`,
		...(t.prerequisites.length ? [`Builds on: ${t.prerequisites.map(oneLine).join(", ")}`] : []),
		...(t.sources.length ? [`Sources: ${t.sources.map(oneLine).join(", ")}`] : []),
		...(oneLine(t.examEvidence) ? [`In past exams: ${oneLine(t.examEvidence)}`] : []),
		"",
		`Goal: ${oneLine(t.goal)}`,
		...(oneLine(t.note) ? ["", oneLine(t.note)] : []),
	];
	return lines.join("\n");
}

/** The subject an exam plan opted into (`fach:`/`subject:` in its front
 *  matter), or null. */
export function planSubject(text: string): string | null {
	const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!fm) return null;
	const line = /^(?:fach|subject)\s*:\s*(.+?)\s*$/im.exec(fm[1]!);
	return line ? line[1]! : null;
}

/** Append the subject's active topics the plan does not have yet. */
export function appendNewTopics(planText: string, topics: readonly Topic[]): { text: string; added: string[]; skipped: string[] } {
	const have = new Set<string>();
	for (const line of planText.split(/\r?\n/)) {
		const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
		if (h2 && !line.startsWith("###")) have.add(focusKey(h2[1]!));
	}
	const added: string[] = [];
	const skipped: string[] = [];
	let text = planText.replace(/\s*$/, "");
	for (const t of learningOrder(topics)) {
		if (have.has(focusKey(t.title))) continue;
		if (have.size >= MAX_EXAM_FOCUSES) {
			skipped.push(oneLine(t.title));
			continue;
		}
		text += `\n\n${topicSection(t)}`;
		have.add(focusKey(t.title));
		added.push(oneLine(t.title));
	}
	return { text: `${text}\n`, added, skipped };
}
