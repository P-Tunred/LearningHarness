/**
 * Second Brain export (fork addition) — PURE: chat records + derived graph
 * in, Markdown notes + a stats document out. No IO here; the server module
 * (src/server/brain.ts) reads the stores and writes the files.
 *
 * Layout inside the brain folder (approved plan, 2026-10-31):
 *   LearnHarness/Sessions/<YYYY-MM-DD> <title>.md   one note per session
 *   LearnHarness/Aussagen/<name>.md                one note per proposition
 *   LearnHarness/learnharness-stats.json           for the Morning Dashboard
 * Links are full-path wikilinks ([[LearnHarness/Aussagen/X|X]]) so they never
 * resolve to one of the user's own notes with the same name.
 *
 * Learning time = the gaps between consecutive recorded actions of a
 * session (message timestamps and answer times); a gap longer than
 * IDLE_GAP_MS is a pause and does not count.
 */
import type { ChatRecord } from "./contracts/chat.ts";
import type { GraphChain, GraphNode, NotesSource } from "./contracts/graph.ts";
import type { DerivedGraph } from "./graph.ts";

export const BRAIN_EXPORT_DIR = "LearnHarness";
export const BRAIN_SESSIONS_DIR = "Sessions";
export const BRAIN_PROPOSITIONS_DIR = "Aussagen";
export const BRAIN_STATS_FILE = "learnharness-stats.json";
/** Pauses longer than this between two actions are not learning time. */
export const IDLE_GAP_MS = 10 * 60 * 1000;
/** Prefix of the provenance label for notes the brain auto-import read. */
export const BRAIN_SOURCE_PREFIX = "Second Brain/";
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

// ─── File naming ─────────────────────────────────────────────────────────────

/** A filename-safe, Obsidian-link-safe version of a title (no extension). */
export function safeFileName(raw: string, fallback = "Unbenannt"): string {
	const cleaned = raw
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.slice(0, 120)
		.trim();
	return cleaned || fallback;
}

/** Assign unique names in a stable order: later duplicates get " (2)", " (3)"… */
function uniqueNames<T>(items: readonly T[], base: (item: T) => string): Map<T, string> {
	const used = new Map<string, number>();
	const out = new Map<T, string>();
	for (const item of items) {
		const name = base(item);
		const key = name.toLowerCase();
		const n = (used.get(key) ?? 0) + 1;
		used.set(key, n);
		out.set(item, n === 1 ? name : `${name} (${n})`);
	}
	return out;
}

const MINUTE = 60_000;
const minutes = (ms: number) => Math.round(ms / MINUTE);

function yamlString(value: string): string {
	return JSON.stringify(value);
}

// ─── The export ──────────────────────────────────────────────────────────────

export interface BrainExportInput {
	chats: readonly ChatRecord[];
	graph: DerivedGraph;
	sources: readonly NotesSource[];
	/** ISO time stamped into the stats document. */
	now: string;
	idleGapMs?: number;
}

export interface BrainExport {
	/** Paths RELATIVE TO THE BRAIN FOLDER (always under LearnHarness/) → content. */
	files: Map<string, string>;
	stats: BrainStats;
}

export interface BrainStats {
	version: 1;
	generatedAt: string;
	idleGapMinutes: number;
	totals: {
		sessions: number;
		learningMinutes: number;
		questions: number;
		graded: number;
		correct: number;
		propositions: number;
		chains: number;
	};
	/** Ascending by date; only days with learning time. */
	days: Array<{ date: string; learningMinutes: number; sessions: number }>;
	/** Newest first. */
	sessions: Array<{
		id: string;
		title: string;
		kind: "teach" | "practice";
		createdAt: string;
		updatedAt: string;
		learningMinutes: number;
		questions: number;
		graded: number;
		correct: number;
		practice: Record<PracticeOutcome, number>;
		propositions: number;
		/** The session's note, relative to the brain folder. */
		note: string;
	}>;
}

const REASON_LABEL: Record<UnsureReason, string> = {
	dontKnow: "Weiß nicht",
	incorrect: "Falsch beantwortet",
	lowConfidence: "Richtig, aber unsicher",
};

const OUTCOME_LABEL: Record<PracticeOutcome, string> = {
	solved: "Gelöst",
	solvedWithHints: "Mit Hinweisen gelöst",
	movedOn: "Weitergegangen",
	surrendered: "Aufgegeben",
};

function oneLine(text: string, max = 300): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function buildBrainExport(input: BrainExportInput): BrainExport {
	const idleGapMs = input.idleGapMs ?? IDLE_GAP_MS;
	const files = new Map<string, string>();
	const nodesById = new Map(input.graph.nodes.map((n) => [n.id, n]));

	// Stable orders → stable, collision-free names across runs.
	const chats = [...input.chats].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	const nodes = [...input.graph.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	const sessionName = uniqueNames(chats, (c) => `${c.createdAt.slice(0, 10)} ${safeFileName(c.title)}`);
	const nodeName = uniqueNames(nodes, (n) => safeFileName(n.name, n.id));
	const chatById = new Map(chats.map((c) => [c.id, c]));
	const sourceById = new Map(input.sources.map((s) => [s.id, s]));

	const sessionPath = (c: ChatRecord) => `${BRAIN_EXPORT_DIR}/${BRAIN_SESSIONS_DIR}/${sessionName.get(c)}`;
	const nodePath = (n: GraphNode) => `${BRAIN_EXPORT_DIR}/${BRAIN_PROPOSITIONS_DIR}/${nodeName.get(n)}`;
	const nodeLink = (id: string) => {
		const n = nodesById.get(id);
		return n ? `[[${nodePath(n)}|${n.name.replace(/[|\]]/g, " ")}]]` : "(entfernt)";
	};
	const sessionLink = (c: ChatRecord) => `[[${sessionPath(c)}|${c.title.replace(/[|\]]/g, " ")}]]`;
	const chainLine = (ch: GraphChain) => `${ch.premises.map(nodeLink).join(" + ")} ⇒ ${nodeLink(ch.conclusion)}`;
	const sourceLine = (sourceId: string): string | null => {
		const s = sourceById.get(sourceId);
		if (!s) return null;
		if (s.filePath.startsWith(BRAIN_SOURCE_PREFIX)) {
			const rel = s.filePath.slice(BRAIN_SOURCE_PREFIX.length).replace(/\.md$/i, "");
			return `Notiz: [[${rel}]]`;
		}
		return `Importierte Notiz: \`${s.filePath}\``;
	};

	const chatsOf = (prov: readonly { chatId: string }[]) => [...new Set(prov.map((p) => p.chatId))];

	// Proposition notes.
	for (const n of nodes) {
		const premiseOf = input.graph.chains.filter((ch) => ch.premises.includes(n.id));
		const concludedBy = input.graph.chains.filter((ch) => ch.conclusion === n.id);
		const lines: string[] = [
			"---",
			`learnharness_id: ${n.id}`,
			`created: ${n.createdAt}`,
			"tags: [learnharness/aussage]",
			"---",
			`# ${n.name}`,
			"",
			n.statement,
		];
		const aliases = [...new Set(n.aliases.filter((a) => a && a !== n.statement))];
		if (aliases.length) lines.push("", "## Andere Formulierungen", ...aliases.map((a) => `- ${oneLine(a)}`));
		if (concludedBy.length) lines.push("", "## Begründet durch", ...concludedBy.map((ch) => `- ${chainLine(ch)}`));
		if (premiseOf.length) lines.push("", "## Führt zu", ...premiseOf.map((ch) => `- ${chainLine(ch)}`));
		const occurrences = chatsOf(n.provenance)
			.map((id) => {
				const chat = chatById.get(id);
				return chat ? `Session: ${sessionLink(chat)}` : sourceLine(id);
			})
			.filter((l): l is string => !!l);
		if (occurrences.length) lines.push("", "## Vorkommen", ...occurrences.map((o) => `- ${o}`));
		files.set(`${nodePath(n)}.md`, `${lines.join("\n")}\n`);
	}

	// Session notes + stats rows.
	const dayTotals = new Map<string, { ms: number; sessions: Set<string> }>();
	const statRows: BrainStats["sessions"] = [];
	let totalMs = 0;
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
			const t = dayTotals.get(day) ?? { ms: 0, sessions: new Set<string>() };
			t.ms += ms;
			t.sessions.add(chat.id);
			dayTotals.set(day, t);
		}
		const sessionNodes = nodes.filter((n) => n.provenance.some((p) => p.chatId === chat.id));
		const sessionChains = input.graph.chains.filter((ch) => ch.provenance.some((p) => p.chatId === chat.id));
		const path = sessionPath(chat);
		statRows.push({
			id: chat.id,
			title: chat.title,
			kind: d.kind,
			createdAt: chat.createdAt,
			updatedAt: chat.updatedAt,
			learningMinutes: minutes(d.learningMs),
			questions: d.questions,
			graded: d.graded,
			correct: d.correct,
			practice: d.practice,
			propositions: sessionNodes.length,
			note: `${path}.md`,
		});

		const lines: string[] = [
			"---",
			`learnharness_session: ${chat.id}`,
			`title: ${yamlString(chat.title)}`,
			`type: ${d.kind === "practice" ? "üben" : "lernen"}`,
			`date: ${chat.createdAt.slice(0, 10)}`,
			`lernzeit_minuten: ${minutes(d.learningMs)}`,
			"tags: [learnharness/session]",
			"---",
			`# ${chat.title}`,
			"",
			`**Datum:** ${chat.createdAt.slice(0, 10)} · **Lernzeit:** ${minutes(d.learningMs)} Min. · **Art:** ${d.kind === "practice" ? "Üben" : "Lernen"}`,
		];
		if (d.questions) {
			const gradedPart = d.graded ? `, davon ${d.correct} von ${d.graded} bewerteten richtig` : "";
			lines.push("", `**Fragen beantwortet:** ${d.questions}${gradedPart}`);
		}
		if (sessionNodes.length) {
			lines.push("", "## Gelernte Aussagen", ...sessionNodes.map((n) => `- ${nodeLink(n.id)}: ${oneLine(n.statement, 200)}`));
		}
		if (sessionChains.length) lines.push("", "## Begründungsketten", ...sessionChains.map((ch) => `- ${chainLine(ch)}`));
		if (d.unsure.length) {
			lines.push("", "## Unsicher oder offen", ...d.unsure.map((u) => {
				const conf = u.confidence !== undefined ? ` (${Math.round(u.confidence)} % sicher)` : "";
				return `- ${REASON_LABEL[u.reason]}${conf}: ${oneLine(u.question)}`;
			}));
		}
		if (d.learnerQuestions.length) lines.push("", "## Deine Fragen", ...d.learnerQuestions.map((q) => `- ${oneLine(q)}`));
		const practiced = PRACTICE_OUTCOMES.filter((o) => d.practice[o] > 0);
		if (practiced.length) lines.push("", "## Übungsergebnisse", ...practiced.map((o) => `- ${OUTCOME_LABEL[o]}: ${d.practice[o]}`));
		files.set(`${path}.md`, `${lines.join("\n")}\n`);
	}

	const stats: BrainStats = {
		version: 1,
		generatedAt: input.now,
		idleGapMinutes: minutes(idleGapMs),
		totals: {
			sessions: chats.length,
			learningMinutes: minutes(totalMs),
			questions: totalQuestions,
			graded: totalGraded,
			correct: totalCorrect,
			propositions: input.graph.nodes.length,
			chains: input.graph.chains.length,
		},
		days: [...dayTotals.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, t]) => ({ date, learningMinutes: minutes(t.ms), sessions: t.sessions.size })),
		sessions: statRows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)),
	};
	files.set(`${BRAIN_EXPORT_DIR}/${BRAIN_STATS_FILE}`, `${JSON.stringify(stats, null, "\t")}\n`);
	return { files, stats };
}

// ─── Import scan decisions (pure) ────────────────────────────────────────────

/** Whether a brain-relative path (POSIX separators) takes part in the auto-import:
 *  Markdown only, never LearnHarness' own export folder, never hidden folders
 *  or files (.obsidian, .trash, .git, …). */
export function brainImportCandidate(relPath: string): boolean {
	const parts = relPath.split("/");
	if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) return false;
	if (parts[0] === BRAIN_EXPORT_DIR) return false;
	return /\.md$/i.test(relPath);
}
