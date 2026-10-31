/**
 * Second Brain export (fork addition) — PURE: chat records + derived graph
 * in, a COARSE learning overview + a stats document out. No IO here; the
 * server module (src/server/brain.ts) reads the stores and writes the files.
 *
 * Coarse on purpose (Paul, 2026-10-31): the brain should know WHAT he is
 * learning and in which context (course folder), not every proposition.
 * The knowledge graph itself stays in LearnHarness.
 *
 * Layout: into `wiki/learnharness/` when the brain has a `wiki/` folder (so
 * the VM mirror, Hermes and the Morning Dashboard see it), else into
 * `LearnHarness/`:
 *   lernstand.md               topics, context, learning time, last active
 *   learnharness-stats.json    the same for the Morning Dashboard
 * Documents to learn from come IN through `LearnHarness/Eingang/`.
 *
 * Learning time = the gaps between consecutive recorded actions of a
 * session (message timestamps and answer times); a gap longer than
 * IDLE_GAP_MS is a pause and does not count.
 */
import type { ChatRecord } from "./contracts/chat.ts";
import type { DerivedGraph } from "./graph.ts";
import type { SourceOrganization } from "./source-organization.ts";

/** Export folder inside a brain that has a `wiki/` (Paul's layout). */
export const BRAIN_WIKI_EXPORT_DIR = "wiki/learnharness";
/** Export folder inside any other Markdown folder. */
export const BRAIN_EXPORT_DIR = "LearnHarness";
/** Drop folder: documents placed here are imported into the graph. */
export const BRAIN_INBOX_DIR = "LearnHarness/Eingang";
/** Imported inbox files move here (inside the inbox). */
export const BRAIN_INBOX_DONE_DIR = "importiert";
export const BRAIN_OVERVIEW_FILE = "lernstand.md";
export const BRAIN_STATS_FILE = "learnharness-stats.json";
/** Pauses longer than this between two actions are not learning time. */
export const IDLE_GAP_MS = 10 * 60 * 1000;
/** Prefix of the provenance label for documents the inbox import read. */
export const BRAIN_SOURCE_PREFIX = "Second Brain/";
/** "Gerade dran" = learning time within this many days before the export. */
export const RECENT_DAYS = 14;
/** How many older topics the overview still lists. */
const MAX_OLDER_TOPICS = 30;
/** Below this self-reported confidence a correct answer still counts as unsure. */
const LOW_CONFIDENCE = 50;

// ─── Learning time ───────────────────────────────────────────────────────────

/** Local calendar day (YYYY-MM-DD) of a millisecond timestamp. */
export function localDay(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Active time per local day: each counted gap belongs to the day it ends on. */
export function learningTimeByDay(timestamps: readonly number[], idleGapMs = IDLE_GAP_MS): Map<string, number> {
	const sorted = timestamps.filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
	const out = new Map<string, number>();
	for (let i = 1; i < sorted.length; i++) {
		const gap = sorted[i]! - sorted[i - 1]!;
		if (gap <= 0 || gap > idleGapMs) continue;
		const day = localDay(sorted[i]!);
		out.set(day, (out.get(day) ?? 0) + gap);
	}
	return out;
}

/** Every recorded action time of a session: message timestamps plus answer times. */
export function actionTimestamps(record: ChatRecord): number[] {
	const out: number[] = [];
	for (const m of record.messages) {
		const t = (m as { timestamp?: unknown }).timestamp;
		if (typeof t === "number") out.push(t);
		const answeredAt = answerDetails(m)?.answeredAt;
		if (typeof answeredAt === "string") {
			const ms = Date.parse(answeredAt);
			if (Number.isFinite(ms)) out.push(ms);
		}
	}
	return out;
}

// ─── Session digest ──────────────────────────────────────────────────────────

interface AnswerDetails {
	kind?: unknown;
	questionText?: unknown;
	correct?: unknown;
	confidence?: unknown;
	dontKnow?: unknown;
	dismissed?: unknown;
	answeredAt?: unknown;
}

function answerDetails(m: unknown): AnswerDetails | null {
	const msg = m as { role?: unknown; details?: unknown };
	if (msg.role !== "toolResult") return null;
	const d = msg.details;
	if (!d || typeof d !== "object" || Array.isArray(d)) return null;
	const details = d as AnswerDetails;
	return typeof details.questionText === "string" ? details : null;
}

export type UnsureReason = "dontKnow" | "incorrect" | "lowConfidence";

export interface UnsureItem {
	question: string;
	reason: UnsureReason;
	confidence?: number;
}

export const PRACTICE_OUTCOMES = ["solved", "solvedWithHints", "movedOn", "surrendered"] as const;
export type PracticeOutcome = (typeof PRACTICE_OUTCOMES)[number];

export interface SessionDigest {
	id: string;
	title: string;
	kind: "teach" | "practice";
	createdAt: string;
	updatedAt: string;
	learningMs: number;
	learningByDay: Map<string, number>;
	/** Answered questions of any kind (ask/quiz/explain), skipped ones excluded. */
	questions: number;
	/** Mechanically graded (quiz) answers and how many were correct. */
	graded: number;
	correct: number;
	unsure: UnsureItem[];
	/** The learner's own typed questions (messages containing "?"). */
	learnerQuestions: string[];
	practice: Record<PracticeOutcome, number>;
}

function userText(m: unknown): string | null {
	const msg = m as { role?: unknown; content?: unknown };
	if (msg.role !== "user") return null;
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return null;
	const text = msg.content
		.filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
		.map((b) => b.text)
		.join("\n");
	return text || null;
}

export function digestSession(record: ChatRecord, idleGapMs = IDLE_GAP_MS): SessionDigest {
	const practice = Object.fromEntries(PRACTICE_OUTCOMES.map((o) => [o, 0])) as Record<PracticeOutcome, number>;
	const failedCalls = new Set<string>();
	for (const m of record.messages) {
		const r = m as { role?: unknown; isError?: unknown; toolCallId?: unknown };
		if (r.role === "toolResult" && r.isError === true && typeof r.toolCallId === "string") failedCalls.add(r.toolCallId);
	}
	let questions = 0;
	let graded = 0;
	let correct = 0;
	const unsure: UnsureItem[] = [];
	const learnerQuestions: string[] = [];
	for (const m of record.messages) {
		const text = userText(m);
		if (text && text.includes("?")) learnerQuestions.push(text.trim());
		const msg = m as { role?: unknown; content?: unknown };
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content as Array<{ type?: unknown; id?: unknown; name?: unknown; arguments?: unknown }>) {
				if (block?.type !== "toolCall" || block.name !== "conclude" || failedCalls.has(String(block.id))) continue;
				const outcome = (block.arguments as { outcome?: unknown } | undefined)?.outcome;
				if (typeof outcome === "string" && (PRACTICE_OUTCOMES as readonly string[]).includes(outcome)) {
					practice[outcome as PracticeOutcome]++;
				}
			}
		}
		const d = answerDetails(m);
		if (!d || d.dismissed === true || d.kind === "ask") continue;
		questions++;
		const question = String(d.questionText).trim();
		if (d.dontKnow === true) {
			unsure.push({ question, reason: "dontKnow" });
			continue;
		}
		const confidence = typeof d.confidence === "number" && Number.isFinite(d.confidence) ? d.confidence : undefined;
		if (typeof d.correct === "boolean") {
			graded++;
			if (d.correct) correct++;
			if (!d.correct) unsure.push({ question, reason: "incorrect", ...(confidence !== undefined ? { confidence } : {}) });
			else if (confidence !== undefined && confidence < LOW_CONFIDENCE) unsure.push({ question, reason: "lowConfidence", confidence });
		}
	}
	const byDay = learningTimeByDay(actionTimestamps(record), idleGapMs);
	let learningMs = 0;
	for (const ms of byDay.values()) learningMs += ms;
	return {
		id: record.id,
		title: record.title,
		kind: record.kind === "practice" ? "practice" : "teach",
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		learningMs,
		learningByDay: byDay,
		questions,
		graded,
		correct,
		unsure,
		learnerQuestions,
		practice,
	};
}


// ─── Topics ──────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const minutes = (ms: number) => Math.round(ms / MINUTE);

/** Folder path of a session in the source tree ("FODS / Woche 5"), or null. */
export function sessionContext(organization: SourceOrganization | undefined, chatId: string): string | null {
	if (!organization) return null;
	const names: string[] = [];
	const seen = new Set<string>();
	let folderId = organization.placements[chatId]?.folderId ?? null;
	while (folderId && !seen.has(folderId)) {
		seen.add(folderId);
		const folder = organization.folders.find((f) => f.id === folderId);
		if (!folder) break;
		names.unshift(folder.name);
		folderId = folder.parentId;
	}
	return names.length ? names.join(" / ") : null;
}

export interface TopicSummary {
	title: string;
	/** Folder path in LearnHarness' source tree, or null when at the root. */
	context: string | null;
	/** Last local day with learning time (or the session's update day). */
	lastActive: string;
	learningMinutesRecent: number;
	learningMinutesTotal: number;
	sessions: number;
	kinds: Array<"teach" | "practice">;
	/** Answers marked don't-know, wrong, or right-but-unsure. Counts only. */
	openQuestions: number;
}

const topicKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");

/** Sessions with the same title (a lesson and its practice) form one topic. */
export function summarizeTopics(
	chats: readonly ChatRecord[],
	organization: SourceOrganization | undefined,
	now: Date,
	idleGapMs = IDLE_GAP_MS,
): TopicSummary[] {
	const since = localDay(now.getTime() - RECENT_DAYS * 24 * 60 * MINUTE);
	const groups = new Map<string, { latest: ChatRecord; summary: TopicSummary; recentMs: number; totalMs: number }>();
	const sorted = [...chats].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
	for (const chat of sorted) {
		const d = digestSession(chat, idleGapMs);
		const days = [...d.learningByDay.keys()].sort();
		const lastActive = days.at(-1) ?? localDay(Date.parse(chat.updatedAt) || 0);
		let recentMs = 0;
		for (const [day, ms] of d.learningByDay) if (day >= since) recentMs += ms;
		const key = topicKey(chat.title);
		const group = groups.get(key);
		if (!group) {
			groups.set(key, {
				latest: chat,
				recentMs,
				totalMs: d.learningMs,
				summary: {
					title: chat.title.trim() || "Ohne Titel",
					context: sessionContext(organization, chat.id),
					lastActive,
					learningMinutesRecent: 0,
					learningMinutesTotal: 0,
					sessions: 1,
					kinds: [d.kind],
					openQuestions: d.unsure.length,
				},
			});
			continue;
		}
		// Later sessions win the title and context; totals add up.
		group.latest = chat;
		group.recentMs += recentMs;
		group.totalMs += d.learningMs;
		const s = group.summary;
		s.title = chat.title.trim() || s.title;
		s.context = sessionContext(organization, chat.id) ?? s.context;
		if (lastActive > s.lastActive) s.lastActive = lastActive;
		s.sessions++;
		if (!s.kinds.includes(d.kind)) s.kinds = [...s.kinds, d.kind].sort();
		s.openQuestions += d.unsure.length;
	}
	return [...groups.values()]
		.map((g) => ({ ...g.summary, learningMinutesRecent: minutes(g.recentMs), learningMinutesTotal: minutes(g.totalMs) }))
		.sort((a, b) => b.lastActive.localeCompare(a.lastActive)
			|| b.learningMinutesRecent - a.learningMinutesRecent
			|| a.title.localeCompare(b.title));
}

// ─── The export ──────────────────────────────────────────────────────────────

/** A Klausur-Auftrag as the export sees it (src/server/exam-plans.ts). */
export interface ExamInput {
	exam: string;
	date: string | null;
	focuses: ReadonlyArray<{ title: string; weight: "hoch" | "mittel" | "niedrig" | null; chatId: string }>;
}

export interface ExamSummary {
	exam: string;
	date: string | null;
	total: number;
	/** Focus sessions with at least one message from Paul. */
	started: number;
	learningMinutes: number;
	openQuestions: number;
	focuses: Array<{
		title: string;
		weight: "hoch" | "mittel" | "niedrig" | null;
		started: boolean;
		learningMinutes: number;
		openQuestions: number;
		lastActive: string | null;
	}>;
}

export interface BrainExportInput {
	chats: readonly ChatRecord[];
	graph: DerivedGraph;
	organization?: SourceOrganization;
	exams?: readonly ExamInput[];
	/** ISO time of the export; "recent" and the overview's date derive from it. */
	now: string;
	idleGapMs?: number;
}

export interface BrainExport {
	/** File name (inside the export folder) → content. */
	files: Map<string, string>;
	stats: BrainStats;
}

export interface BrainStats {
	version: 2;
	generatedAt: string;
	idleGapMinutes: number;
	recentDays: number;
	totals: {
		sessions: number;
		learningMinutes: number;
		learningMinutesRecent: number;
		questions: number;
		graded: number;
		correct: number;
		propositions: number;
		chains: number;
	};
	/** Ascending by date; only days with learning time. */
	days: Array<{ date: string; learningMinutes: number; sessions: number }>;
	/** Most recently active first — what the dashboard shows as current topics. */
	topics: TopicSummary[];
	/** Klausur-Aufträge, nearest date first (absent: none). */
	exams?: ExamSummary[];
	/** Newest first. */
	sessions: Array<{
		id: string;
		title: string;
		kind: "teach" | "practice";
		context: string | null;
		createdAt: string;
		updatedAt: string;
		learningMinutes: number;
		questions: number;
		graded: number;
		correct: number;
		practice: Record<PracticeOutcome, number>;
	}>;
}

/** Progress of each exam plan, from its focus sessions. */
export function summarizeExams(exams: readonly ExamInput[], chats: readonly ChatRecord[], idleGapMs = IDLE_GAP_MS): ExamSummary[] {
	const byId = new Map(chats.map((c) => [c.id, c]));
	return exams.map((e) => {
		const focuses = e.focuses.map((f) => {
			const chat = byId.get(f.chatId);
			const d = chat ? digestSession(chat, idleGapMs) : null;
			const started = !!chat && chat.messages.some((m) => (m as { role?: unknown }).role === "user");
			return {
				title: f.title,
				weight: f.weight,
				started,
				learningMinutes: d ? minutes(d.learningMs) : 0,
				openQuestions: d ? d.unsure.length : 0,
				lastActive: d ? ([...d.learningByDay.keys()].sort().at(-1) ?? null) : null,
			};
		});
		return {
			exam: e.exam,
			date: e.date,
			total: focuses.length,
			started: focuses.filter((f) => f.started).length,
			learningMinutes: focuses.reduce((sum, f) => sum + f.learningMinutes, 0),
			openQuestions: focuses.reduce((sum, f) => sum + f.openQuestions, 0),
			focuses,
		};
	}).sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.exam.localeCompare(b.exam));
}

/** "1 h 05 min" / "40 min" — the Daily style. */
export function formatMinutes(total: number): string {
	if (total < 60) return `${total} min`;
	const h = Math.floor(total / 60);
	const m = total % 60;
	return m ? `${h} h ${String(m).padStart(2, "0")} min` : `${h} h`;
}

function localStamp(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${localDay(d.getTime())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

function overviewMarkdown(stats: BrainStats): string {
	const stand = localStamp(stats.generatedAt);
	const recent = stats.topics.filter((t) => t.learningMinutesRecent > 0);
	const older = stats.topics.filter((t) => t.learningMinutesRecent === 0).slice(0, MAX_OLDER_TOPICS);
	const kindLabel = (t: TopicSummary) => t.kinds.map((k) => (k === "practice" ? "Üben" : "Lernen")).join(", ");
	const lines = [
		"# Lernstand (LearnHarness)",
		"",
		"Woran Paul in LearnHarness gerade lernt, grob zusammengefasst: Themen, Rahmen und Lernzeit — nicht die einzelnen Inhalte.",
		"",
		"> Diese Seite schreibt LearnHarness automatisch und überschreibt sie bei jeder Änderung. Nicht von Hand bearbeiten; Ergänzungen gehören auf die passende Fachseite.",
		"",
		`**Stand:** ${stand} · **Lernzeit der letzten ${stats.recentDays} Tage:** ${formatMinutes(stats.totals.learningMinutesRecent)} · **insgesamt:** ${formatMinutes(stats.totals.learningMinutes)} in ${stats.totals.sessions} Sessions`,
		"",
	];
	if (stats.exams?.length) {
		lines.push("## Klausuren", "");
		for (const e of stats.exams) {
			lines.push(
				`### ${cell(e.exam)}${e.date ? ` — ${e.date}` : ""}`,
				"",
				`${e.started} von ${e.total} Schwerpunkten angefangen · ${formatMinutes(e.learningMinutes)} · ${e.openQuestions} offene Fragen`,
				"",
				"| Schwerpunkt | Gewicht | Stand | Lernzeit | Offene Fragen |",
				"|---|---|---|---|---|",
				...e.focuses.map((f) => `| ${cell(f.title)} | ${f.weight ?? "—"} | ${f.started ? `angefangen${f.lastActive ? `, zuletzt ${f.lastActive}` : ""}` : "offen"} | ${formatMinutes(f.learningMinutes)} | ${f.openQuestions} |`),
				"",
			);
		}
	}
	lines.push(`## Gerade dran (letzte ${stats.recentDays} Tage)`, "");
	if (recent.length) {
		lines.push("| Thema | Rahmen | Lernzeit | Zuletzt | Art | Offene Fragen |", "|---|---|---|---|---|---|");
		for (const t of recent) {
			lines.push(`| ${cell(t.title)} | ${cell(t.context ?? "—")} | ${formatMinutes(t.learningMinutesRecent)} | ${t.lastActive} | ${kindLabel(t)} | ${t.openQuestions} |`);
		}
	} else {
		lines.push(`In den letzten ${stats.recentDays} Tagen keine Lernzeit in LearnHarness.`);
	}
	if (older.length) {
		lines.push("", "## Früher gelernt", "");
		for (const t of older) {
			const ctx = t.context ? ` (${t.context})` : "";
			lines.push(`- ${cell(t.title)}${ctx} — zuletzt ${t.lastActive}, insgesamt ${formatMinutes(t.learningMinutesTotal)}`);
		}
	}
	lines.push(
		"",
		"## So hängt das zusammen",
		"",
		"- **Rahmen** ist der Ordner, in dem die Session in LearnHarness liegt (z. B. ein Fach).",
		"- **Offene Fragen** zählt Antworten mit „Weiß nicht“, falschen oder unsicheren Antworten — nur die Anzahl.",
		"- Dokumente zum Lernen kommen über den Ordner `LearnHarness/Eingang/` im Brain in LearnHarness hinein.",
		"- Klausurpläne (z. B. von Claude) kommen nach `LearnHarness/Auftraege/`; jeder Schwerpunkt wird eine Session im Ordner der Klausur.",
		"",
		"## Quellen",
		"",
		`- LearnHarness auf Pauls Mac (Sessions, Wissensgraph, Ordner), automatisch exportiert (Stand: ${stand}).`,
	);
	return `${lines.join("\n")}\n`;
}

export function buildBrainExport(input: BrainExportInput): BrainExport {
	const idleGapMs = input.idleGapMs ?? IDLE_GAP_MS;
	const now = new Date(input.now);
	const since = localDay(now.getTime() - RECENT_DAYS * 24 * 60 * MINUTE);
	const chats = [...input.chats].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

	const dayTotals = new Map<string, { ms: number; sessions: Set<string> }>();
	const sessionRows: BrainStats["sessions"] = [];
	let totalMs = 0;
	let recentMs = 0;
	let totalQuestions = 0;
	let totalGraded = 0;
	let totalCorrect = 0;
	for (const chat of chats) {
		const d = digestSession(chat, idleGapMs);
		totalMs += d.learningMs;
		totalQuestions += d.questions;
		totalGraded += d.graded;
		totalCorrect += d.correct;
		for (const [day, ms] of d.learningByDay) {
			if (day >= since) recentMs += ms;
			const t = dayTotals.get(day) ?? { ms: 0, sessions: new Set<string>() };
			t.ms += ms;
			t.sessions.add(chat.id);
			dayTotals.set(day, t);
		}
		sessionRows.push({
			id: chat.id,
			title: chat.title,
			kind: d.kind,
			context: sessionContext(input.organization, chat.id),
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
			learningMinutes: minutes(d.learningMs),
			questions: d.questions,
			graded: d.graded,
			correct: d.correct,
			practice: d.practice,
		});
	}

	const stats: BrainStats = {
		version: 2,
		generatedAt: input.now,
		idleGapMinutes: minutes(idleGapMs),
		recentDays: RECENT_DAYS,
		totals: {
			sessions: chats.length,
			learningMinutes: minutes(totalMs),
			learningMinutesRecent: minutes(recentMs),
			questions: totalQuestions,
			graded: totalGraded,
			correct: totalCorrect,
			propositions: input.graph.nodes.length,
			chains: input.graph.chains.length,
		},
		days: [...dayTotals.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, t]) => ({ date, learningMinutes: minutes(t.ms), sessions: t.sessions.size })),
		topics: summarizeTopics(chats, input.organization, now, idleGapMs),
		...(input.exams?.length ? { exams: summarizeExams(input.exams, chats, idleGapMs) } : {}),
		sessions: sessionRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
	};
	const files = new Map<string, string>([
		[BRAIN_OVERVIEW_FILE, overviewMarkdown(stats)],
		[BRAIN_STATS_FILE, `${JSON.stringify(stats, null, "\t")}\n`],
	]);
	return { files, stats };
}

// ─── Inbox scan decisions (pure) ─────────────────────────────────────────────

/** Whether an inbox-relative path (POSIX separators) is a document to import:
 *  Markdown, text or PDF; never hidden files/folders or already imported ones. */
export function inboxImportCandidate(relPath: string): boolean {
	const parts = relPath.split("/");
	if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) return false;
	if (parts[0] === BRAIN_INBOX_DONE_DIR) return false;
	return /\.(?:md|markdown|txt|pdf)$/i.test(relPath);
}
