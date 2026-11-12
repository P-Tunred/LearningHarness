/**
 * Fach-Überprüfung (fork addition, Paul 2026-11-09) — PURE: one subject's
 * materials (weekly slides, past exams), its previous plan and Paul's
 * learning record in; the prompt for one review run, the schema and
 * validation of its answer, and the plan.md / aenderungen.md it becomes.
 * No IO; src/server/subject-review.ts reads the folder and runs the model.
 *
 * WHY: a plan made once and then ticked off per lecture goes stale. Every
 * time new material arrives the whole subject is looked at again — topics
 * across lectures, what past exams really ask, what Paul really knows —
 * starting from the previous plan, which the run must account for topic by
 * topic (kept, changed, merged, renamed or obsolete, never silently gone).
 *
 * FOLDER (in the brain):  LearnHarness/Faecher/<Fach>/
 *   Folien/       weekly slides (.pdf, .md, .txt)
 *   Klausuren/    past exams
 *   fach.md       optional: front matter exam/klausur, date/datum,
 *                 hours_per_week/stunden_pro_woche, language/sprache;
 *                 the body is passed on as Paul's notes
 *   plan.md       written by the review (Paul may edit it; the next run
 *                 reads his edits as part of the previous plan)
 *   aenderungen.md  what each run changed and why, newest first
 */

import { Type, type Static } from "typebox";
import { frontMatter, hours, validDate } from "./exam-plan.ts";

export const SUBJECTS_DIR = "LearnHarness/Faecher";
export const SLIDES_DIR = "Folien";
export const PAST_EXAMS_DIR = "Klausuren";
export const META_FILE = "fach.md";
export const PLAN_FILE = "plan.md";
export const CHANGES_FILE = "aenderungen.md";
/** Material text one run may read (~100k tokens); longer files are cut evenly. */
export const MATERIAL_BUDGET_CHARS = 400_000;
/** Below this a file is never cut (short exams stay whole). */
const MIN_FILE_CHARS = 4_000;
/** Kept in aenderungen.md (older runs are dropped). */
const MAX_CHANGE_RUNS = 30;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface SubjectMeta {
	exam: string | null;
	date: string | null;
	hoursPerWeek: number | null;
	language: string | null;
	notes: string;
}

export function parseSubjectMeta(text: string | null): SubjectMeta {
	if (!text) return { exam: null, date: null, hoursPerWeek: null, language: null, notes: "" };
	const { meta, rest } = frontMatter(text);
	return {
		exam: meta.exam?.trim() || meta.klausur?.trim() || null,
		date: validDate(meta.date ?? meta.datum),
		hoursPerWeek: hours(meta.hours_per_week ?? meta.stunden_pro_woche),
		language: meta.language?.trim() || meta.sprache?.trim() || null,
		notes: rest.trim(),
	};
}

export interface Material {
	kind: "slides" | "exam";
	/** Path inside the subject folder, e.g. "Folien/Woche 03.pdf". */
	name: string;
	text: string;
}

/** What Paul's record says about one session of this subject. */
export interface LearnerSession {
	title: string;
	minutes: number;
	questions: number;
	graded: number;
	correct: number;
	/** Questions he did not know, got wrong or was unsure about (texts). */
	unsure: string[];
	lastActive: string;
}

export interface ReviewInput {
	subject: string;
	meta: SubjectMeta;
	materials: Material[];
	/** plan.md as it is now (Paul's edits included); null on the first run. */
	previousPlan: string | null;
	learner: LearnerSession[];
	/** YYYY-MM-DD, local. */
	today: string;
}

/** Fit materials into the budget: short files stay whole, longer ones are
 *  cut to an even share. Exported for tests. */
export function fitMaterials(materials: readonly Material[], budget = MATERIAL_BUDGET_CHARS): Array<Material & { cut: boolean }> {
	const total = materials.reduce((s, m) => s + m.text.length, 0);
	if (total <= budget) return materials.map((m) => ({ ...m, cut: false }));
	// Water-filling: find the per-file cap that spends the budget.
	const lengths = materials.map((m) => m.text.length).sort((a, b) => a - b);
	let rest = budget;
	let cap = MIN_FILE_CHARS;
	for (let i = 0; i < lengths.length; i++) {
		const share = rest / (lengths.length - i);
		if (lengths[i]! <= share) {
			rest -= lengths[i]!;
		} else {
			cap = Math.max(MIN_FILE_CHARS, Math.floor(share));
			break;
		}
	}
	return materials.map((m) => (m.text.length > cap ? { ...m, text: `${m.text.slice(0, cap)}\n[… cut: ${m.text.length - cap} more characters]`, cut: true } : { ...m, cut: false }));
}

/** Titles of the active topics in a plan.md (its "## " headings). */
export function previousTopicTitles(plan: string | null): string[] {
	if (!plan) return [];
	const { rest } = frontMatter(plan);
	const out: string[] = [];
	for (const line of rest.split(/\r?\n/)) {
		const m = /^##\s+(.+?)\s*$/.exec(line);
		if (m) out.push(m[1]!);
	}
	return out;
}

// ─── The answer ──────────────────────────────────────────────────────────────

const Weight = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);

export const REVIEW_SCHEMA = Type.Object({
	summary: Type.String({ description: "2–4 sentences: where the subject stands now and what this run changed." }),
	topics: Type.Array(
		Type.Object({
			title: Type.String({ description: "Short, stable topic name. Keep a previous topic's exact title unless you rename it (then list a 'renamed' change)." }),
			status: Type.Union([Type.Literal("active"), Type.Literal("obsolete")], { description: "obsolete = no longer worth its own topic (merged, superseded, out of scope); keep it listed with the reason in note." }),
			weight: Weight,
			effortHours: Type.Number({ description: "Hours Paul should plan for it from scratch (0.25–40)." }),
			sources: Type.Array(Type.String(), { description: "Material names it rests on, e.g. 'Folien/Woche 03.pdf'." }),
			prerequisites: Type.Array(Type.String(), { description: "Titles of topics in this plan it builds on." }),
			examEvidence: Type.String({ description: "How past exams ask it (task types, points, frequency) — or 'no past exam evidence'." }),
			learnerState: Type.Union([Type.Literal("not-started"), Type.Literal("shaky"), Type.Literal("solid")], { description: "From Paul's record only; never 'solid' without evidence." }),
			goal: Type.String({ description: "1–3 sentences: what Paul must be able to do in the exam." }),
			note: Type.String({ description: "Why it changed in this run, or what to watch out for; may be empty." }),
		}),
	),
	changes: Type.Array(
		Type.Object({
			kind: Type.Union([
				Type.Literal("added"), Type.Literal("changed"), Type.Literal("merged"), Type.Literal("split"),
				Type.Literal("renamed"), Type.Literal("obsolete"), Type.Literal("reweighted"),
			]),
			topic: Type.String({ description: "The topic's title (for renamed/merged: the OLD title)." }),
			reason: Type.String(),
		}),
	),
	conflicts: Type.Array(
		Type.Object({ topic: Type.String(), description: Type.String(), sources: Type.Array(Type.String()) }),
		{ description: "Contradictions or inconsistencies between materials." },
	),
	openQuestions: Type.Array(Type.String(), { description: "What Paul should clarify (missing info, unclear scope)." }),
	lectures: Type.Array(
		Type.Object({
			file: Type.String({ description: "The slide file's exact material name, e.g. 'Folien/Woche 03.md'. Every file in Folien/ exactly once." }),
			title: Type.String({ description: "What the lecture is about, in a few words (e.g. 'Firewalls and packet filtering')." }),
			weight: Weight,
			effortHours: Type.Number({ description: "Hours Paul should plan to learn this lecture exam-ready from scratch (0.25–40)." }),
			examRelevant: Type.Array(Type.String(), { description: "What he must master for the exam, most important first; each point names its past-exam evidence when there is some." }),
			brief: Type.Array(Type.String(), { description: "What only needs a quick look (rarely or never asked)." }),
			taskFormats: Type.String({ description: "How past exams ask this lecture's content (task types, points) — or 'no past exam evidence'." }),
		}),
		{ description: "Per lecture (one slide file each): the exam-first analysis its learning session starts from." },
	),
});
export type ReviewResult = Static<typeof REVIEW_SCHEMA>;
export type Lecture = ReviewResult["lectures"][number];
export type Topic = ReviewResult["topics"][number];

const norm = (s: string) => s.trim().toLowerCase();

/** Weak-model tolerance at the submit seam: arrays default to empty. */
export function fillReview(raw: Partial<ReviewResult>): ReviewResult {
	return {
		summary: raw.summary ?? "",
		topics: (raw.topics ?? []).map((t) => ({
			...t,
			sources: t.sources ?? [],
			prerequisites: t.prerequisites ?? [],
			examEvidence: t.examEvidence ?? "",
			note: t.note ?? "",
		})),
		changes: raw.changes ?? [],
		conflicts: raw.conflicts ?? [],
		openQuestions: raw.openQuestions ?? [],
		lectures: (raw.lectures ?? []).map((l) => ({
			...l,
			examRelevant: l.examRelevant ?? [],
			brief: l.brief ?? [],
			taskFormats: l.taskFormats ?? "",
		})),
	};
}

/** The laws a run must keep; a problem string makes the model retry. */
export function validateReview(r: ReviewResult, previousTitles: readonly string[], slideFiles: readonly string[] = []): string | null {
	const titles = r.topics.map((t) => t.title.trim());
	if (titles.some((t) => !t)) return "Every topic needs a title.";
	const seen = new Set<string>();
	for (const t of titles) {
		if (seen.has(norm(t))) return `Duplicate topic title: "${t}". Merge them or name them apart.`;
		seen.add(norm(t));
	}
	if (!r.topics.some((t) => t.status === "active")) return "The plan needs at least one active topic.";
	for (const t of r.topics) {
		if (!(t.effortHours >= 0.25 && t.effortHours <= 40)) return `effortHours of "${t.title}" must be between 0.25 and 40.`;
		const missing = t.prerequisites.filter((p) => !seen.has(norm(p)));
		if (missing.length) return `"${t.title}" lists prerequisites that are not topics in this plan: ${missing.join(", ")}.`;
	}
	// Every previous topic is accounted for: still here (active or obsolete),
	// or named as renamed/merged/split in the changes.
	const changed = new Set(r.changes.filter((c) => c.kind === "renamed" || c.kind === "merged" || c.kind === "split").map((c) => norm(c.topic)));
	const lost = previousTitles.filter((t) => !seen.has(norm(t)) && !changed.has(norm(t)));
	if (lost.length) {
		return `These topics of the previous plan are missing: ${lost.join(", ")}. Keep each one (active or obsolete with a reason in note), or list it as renamed/merged/split in changes.`;
	}
	// Every slide file is one lecture, exactly once (its learning session).
	const wanted = new Set(slideFiles);
	const counted = new Map<string, number>();
	for (const l of r.lectures) {
		if (!wanted.has(l.file)) return `lectures names "${l.file}", which is not a slide file. Use the exact names: ${slideFiles.join(", ")}.`;
		counted.set(l.file, (counted.get(l.file) ?? 0) + 1);
		if (!(l.effortHours >= 0.25 && l.effortHours <= 40)) return `effortHours of lecture "${l.file}" must be between 0.25 and 40.`;
		if (!l.title.trim()) return `Lecture "${l.file}" needs a title.`;
	}
	const twice = [...counted].filter(([, n]) => n > 1).map(([f]) => f);
	if (twice.length) return `Each slide file is one lecture, once: ${twice.join(", ")} appear more than once.`;
	const missingLectures = slideFiles.filter((f) => !counted.has(f));
	if (missingLectures.length) return `These slide files have no entry in lectures: ${missingLectures.join(", ")}. Analyse every lecture.`;
	return null;
}

// ─── The prompt ──────────────────────────────────────────────────────────────

export const REVIEW_SYSTEM_PROMPT = `You maintain the study plan for one university subject of Paul, a student. You are called whenever new material (weekly lecture slides, past exams) arrives. Look at the WHOLE subject every time — topics are planned across lectures, never lecture by lecture; separately, each lecture gets its own exam-first analysis for its learning session (point 5).

Produce the complete updated plan and submit it with submit_plan. Check five things and let them shape it:
1. Topics and connections. Group by concept across lectures: one topic may draw on several lectures, a lecture may feed several topics. Name prerequisites (titles of other topics in your plan). Report contradictions or inconsistencies between materials in conflicts.
2. Exam relevance. Weight each topic by what the past exams actually ask (task types, points, how often) and say so in examEvidence. Without past exams, weight by emphasis in the slides and write "no past exam evidence".
3. Paul's real understanding. Use only his learning record: topics he got wrong, did not know or was unsure about are "shaky" and need a note; "solid" needs clear evidence; no record means "not-started".
4. The previous plan itself. It is your starting point and Paul may have edited it — respect his edits. Account for EVERY previous topic: keep it, change it, or mark it obsolete with the reason; renames, merges and splits go into changes with the OLD title. Never let a topic disappear silently. Keep titles stable so his progress stays attached.
5. Every lecture for its own learning session. In lectures, give EVERY file in Folien/ exactly once (file = its exact name): what it is about, its weight and effort for the exam, what of it he must master for the exam (most important first, with the past-exam evidence), what only needs a quick look, and how past exams ask it. This is what the tutor teaches from, exam-first.

Ground everything in the materials and cite them in sources by their names. Do not invent content that is not in the materials; if something needed is missing, say so in openQuestions. Topics should take about 1–6 hours each. Write titles, goals and notes in the language of the slides unless the subject notes name a language.`;

function learnerBlock(sessions: readonly LearnerSession[]): string {
	if (sessions.length === 0) return "(no sessions in this subject yet)";
	return sessions
		.map((s) => {
			const graded = s.graded ? `, ${s.correct}/${s.graded} graded answers right` : "";
			const unsure = s.unsure.length ? `\n  unsure/wrong/didn't know: ${s.unsure.slice(0, 8).map((u) => `"${u.slice(0, 160)}"`).join("; ")}` : "";
			return `- ${s.title} — ${s.minutes} min, ${s.questions} questions${graded}, last ${s.lastActive}${unsure}`;
		})
		.join("\n");
}

/** The user prompt for one run. */
export function buildReviewPrompt(input: ReviewInput): string {
	const fitted = fitMaterials(input.materials);
	const meta = input.meta;
	const head = [
		`Subject: ${input.subject}`,
		`Today: ${input.today}`,
		meta.exam ? `Exam: ${meta.exam}` : null,
		meta.date ? `Exam date: ${meta.date}` : "Exam date: unknown",
		meta.hoursPerWeek ? `Planned hours per week: ${meta.hoursPerWeek}` : null,
		meta.language ? `Language for the plan: ${meta.language}` : null,
	].filter(Boolean).join("\n");
	const section = (kind: Material["kind"], label: string) => {
		const items = fitted.filter((m) => m.kind === kind);
		if (items.length === 0) return `## ${label}\n(none yet)`;
		return `## ${label}\n\n${items.map((m) => `### ${m.name}${m.cut ? " (cut to fit)" : ""}\n\n${m.text}`).join("\n\n")}`;
	};
	return [
		head,
		meta.notes ? `## Paul's notes on the subject (fach.md)\n\n${meta.notes}` : null,
		`## Previous plan (plan.md, possibly edited by Paul)\n\n${input.previousPlan?.trim() || "(none — this is the first run)"}`,
		`## Paul's learning record in this subject\n\n${learnerBlock(input.learner)}`,
		section("exam", "Past exams (Klausuren/)"),
		section("slides", "Lecture slides (Folien/)"),
		"Now submit the complete updated plan with submit_plan.",
	].filter(Boolean).join("\n\n");
}

// ─── Writing it out ──────────────────────────────────────────────────────────

const WEIGHT_DE: Record<Topic["weight"], string> = { high: "hoch", medium: "mittel", low: "niedrig" };
const STATE_DE: Record<Topic["learnerState"], string> = { "not-started": "noch nicht angefangen", shaky: "wackelig", solid: "sitzt" };
const CHANGE_DE: Record<ReviewResult["changes"][number]["kind"], string> = {
	added: "neu", changed: "geändert", merged: "zusammengelegt", split: "aufgeteilt",
	renamed: "umbenannt", obsolete: "überholt", reweighted: "neu gewichtet",
};
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** plan.md: front matter, summary, one "## " section per active topic
 *  (most important first), obsolete topics listed at the end. */
export function renderPlan(subject: string, meta: SubjectMeta, r: ReviewResult, at: string, run: number): string {
	const order: Record<Topic["weight"], number> = { high: 0, medium: 1, low: 2 };
	const active = r.topics.filter((t) => t.status === "active").sort((a, b) => order[a.weight] - order[b.weight]);
	const obsolete = r.topics.filter((t) => t.status === "obsolete");
	const lines: string[] = [
		"---",
		`klausur: ${meta.exam ?? subject}`,
		...(meta.date ? [`datum: ${meta.date}`] : []),
		...(meta.hoursPerWeek ? [`stunden_pro_woche: ${meta.hoursPerWeek}`] : []),
		`stand: ${at}`,
		`durchlauf: ${run}`,
		"erstellt_von: LearnHarness Fach-Überprüfung (Änderungen hier fließen in den nächsten Durchlauf ein)",
		"---",
		`# ${subject}: Lernplan`,
		"",
		oneLine(r.summary),
	];
	for (const t of active) {
		lines.push(
			"",
			`## ${t.title.trim()}`,
			`Gewicht: ${WEIGHT_DE[t.weight]}`,
			`Aufwand: ${t.effortHours} h`,
			`Stand: ${STATE_DE[t.learnerState]}`,
			...(t.prerequisites.length ? [`Voraussetzungen: ${t.prerequisites.join(", ")}`] : []),
			...(t.sources.length ? [`Quellen: ${t.sources.join(", ")}`] : []),
			`Klausur: ${oneLine(t.examEvidence) || "keine Angabe"}`,
			"",
			oneLine(t.goal),
			...(t.note.trim() ? ["", `Hinweis: ${oneLine(t.note)}`] : []),
		);
	}
	if (r.conflicts.length) {
		lines.push("", "# Widersprüche in den Unterlagen", ...r.conflicts.map((c) => `- **${c.topic}**: ${oneLine(c.description)}${c.sources.length ? ` (${c.sources.join(", ")})` : ""}`));
	}
	if (r.openQuestions.length) lines.push("", "# Offene Fragen", ...r.openQuestions.map((q) => `- ${oneLine(q)}`));
	if (obsolete.length) lines.push("", "# Überholte Themen", ...obsolete.map((t) => `- ${t.title.trim()}: ${oneLine(t.note) || "überholt"}`));
	return `${lines.join("\n")}\n`;
}

/** aenderungen.md: this run's section on top of the earlier ones. */
export function renderChanges(previous: string | null, subject: string, r: ReviewResult, at: string, newMaterials: readonly string[]): string {
	const header = `# ${subject}: Änderungen am Lernplan\n`;
	const section = [
		`## ${at.replace("T", " ").slice(0, 16)}`,
		newMaterials.length ? `Neu dazugekommen: ${newMaterials.join(", ")}` : "Neu bewertet (keine neuen Dateien).",
		"",
		oneLine(r.summary),
		"",
		...(r.changes.length ? r.changes.map((c) => `- **${CHANGE_DE[c.kind]}**: ${c.topic.trim()} — ${oneLine(c.reason)}`) : ["- keine Änderungen am Plan"]),
		...(r.conflicts.length ? ["", `Widersprüche: ${r.conflicts.length} (siehe plan.md)`] : []),
	].join("\n");
	const earlier = (previous ?? "").replace(/^# .*\n/, "").split(/\n(?=## )/).map((s) => s.trim()).filter(Boolean);
	return `${header}\n${[section, ...earlier].slice(0, MAX_CHANGE_RUNS).join("\n\n")}\n`;
}

// ─── One learning session per lecture (Paul, 2026-11-12) ────────────────────
//
// "Ich lade jede Vorlesung hoch und lerne sie, optimiert auf die Klausur":
// the review's per-lecture analysis becomes a Klausur-Auftrag
// (src/core/exam-plan.ts) at LearnHarness/Auftraege/<Fach> Vorlesungen.md.
// The existing plan machinery then makes one session per lecture in the
// exam's folder, with progress, notch, XP and topic_status — nothing new
// downstream. Each section title comes from the FILE NAME, never from the
// model, so it stays stable across runs and a session is never duplicated.

/** File name of a subject's lecture plan inside LearnHarness/Auftraege/. */
export const lecturePlanFile = (subject: string) => `${subject} Vorlesungen.md`;

/** The stable session title of one lecture: "<Fach>: <file name without extension>". */
export function lectureTitle(subject: string, file: string): string {
	const base = file.split("/").pop() ?? file;
	return `${subject}: ${base.replace(/\.(md|markdown|txt|pdf)$/i, "").trim()}`;
}

/** Lectures in a natural order ("Woche 2" before "Woche 10"). */
const byFile = (a: Lecture, b: Lecture) => a.file.localeCompare(b.file, undefined, { numeric: true, sensitivity: "base" });

/**
 * The Auftrag for a subject's lectures. `slidePath(file)` gives the path the
 * tutor can read (absolute in the brain), `examsDir` the past exams.
 * Written by LearnHarness — the header says so; edits are overwritten.
 */
export function renderLecturePlan(
	subject: string,
	meta: SubjectMeta,
	lectures: readonly Lecture[],
	paths: { slidePath: (file: string) => string; examsDir: string },
	at: string,
): string {
	const fm = [
		"---",
		`klausur: ${meta.exam ?? subject}`,
		...(meta.date ? [`datum: ${meta.date}`] : []),
		...(meta.hoursPerWeek ? [`stunden_pro_woche: ${meta.hoursPerWeek}`] : []),
		"---",
	];
	const lines = [
		...fm,
		`# ${subject}: eine Session pro Vorlesung`,
		`Automatically written by LearnHarness from the subject review (${at.slice(0, 10)}) — edits here are overwritten; Paul's own notes go into fach.md.`,
		"Every lecture is taught exam-first: the exam-relevant points first and deepest, the rest briefly, practised in the exams' task formats.",
	];
	for (const l of [...lectures].sort(byFile)) {
		lines.push(
			"",
			`## ${lectureTitle(subject, l.file)}`,
			`Gewicht: ${WEIGHT_DE[l.weight]}`,
			`Aufwand: ${Math.round(l.effortHours * 4) / 4} h`,
			"",
			`Lecture: ${oneLine(l.title)}`,
			`Slides (read them first): \`${paths.slidePath(l.file)}\``,
			`Past exams: \`${paths.examsDir}\``,
		);
		if (l.examRelevant.length) lines.push("", "Exam-relevant — master these, most important first:", ...l.examRelevant.map((x) => `- ${oneLine(x)}`));
		if (l.brief.length) lines.push("", "Only needs a quick look:", ...l.brief.map((x) => `- ${oneLine(x)}`));
		lines.push("", `How the exams ask it: ${oneLine(l.taskFormats) || "no past exam evidence"}`);
	}
	return `${lines.join("\n")}\n`;
}
