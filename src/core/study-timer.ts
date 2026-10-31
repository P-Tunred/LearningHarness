/**
 * Study timer (fork addition) — PURE: the measured learning time behind
 * the floating timer, which subject it belongs to, and how it adds up per
 * day. No IO; src/server/study-timer.ts stores the state and serves it.
 *
 * Why (Paul, 2026-10-31): the export estimates learning time from the gaps
 * between his messages, which misses reading, thinking and note-taking.
 * The timer measures; the estimate stays the fallback where it did not run.
 *
 * MODEL
 * Time is booked as PIECES: one subject, one chat (or none), a start and an
 * end. The running piece is stored on every heartbeat, so a crash loses at
 * most one beat. Switching chats while running closes the piece and opens
 * a new one at the same instant — nothing is booked twice or to the wrong
 * subject.
 *
 * SUBJECT (first match wins)
 *  0. Paul assigned this chat a subject by hand.
 *  1. The chat is a focus session of a Klausur-Auftrag → the exam's name;
 *     its time also belongs to that focus (the piece keeps the chatId).
 *  2. The chat sits in a folder → the top-level folder's name.
 *  3. Otherwise no subject; the timer says so and a click assigns one.
 *
 * NEVER BOOKED
 *  - Sleep, quit, crash: no heartbeat for STALE_MS → the piece ends at the
 *    last heartbeat and the timer stays paused (no question on waking).
 *  - Idle: no input or scrolling for IDLE_ASK_MS → the timer asks; with no
 *    answer IDLE_PAUSE_MS after the last input it pauses and the piece ends
 *    at that last input, so the idle stretch is not booked.
 */

import { examFolderName } from "./exam-plan.ts";
import type { SourceOrganization } from "./source-organization.ts";

/** The timer asks "Still there?" after this long without input. */
export const IDLE_ASK_MS = 15 * 60 * 1000;
/** …and pauses (booking up to the last input) this long after it. */
export const IDLE_PAUSE_MS = 20 * 60 * 1000;
/** The window beats this often while the timer runs. */
export const BEAT_MS = 30 * 1000;
/** No beat for this long = the machine slept or the app quit. Chromium
 *  throttles hidden windows to about one timer per minute, so this must
 *  stay well above a minute. */
export const STALE_MS = 3 * 60 * 1000;
/** Closed pieces kept (oldest dropped first) — years of normal use. */
const MAX_PIECES = 20_000;
/** Pieces shorter than this are noise (a switch right after a start). */
const MIN_PIECE_MS = 1000;
/** Export key for time without a subject (Daily reads German keys). */
export const NO_SUBJECT = "Ohne Fach";

export interface TimerContext {
	/** null = no subject yet. */
	subject: string | null;
	/** The chat the time was spent in (focus attribution), or null. */
	chatId: string | null;
}

export interface TimerPiece extends TimerContext {
	start: number;
	end: number;
}

export interface RunningPiece extends TimerContext {
	start: number;
	/** Last heartbeat from the window. */
	beatAt: number;
	/** Last input or scrolling in the window. */
	activeAt: number;
}

export interface TimerState {
	version: 1;
	pieces: TimerPiece[];
	running: RunningPiece | null;
	/** The context the timer shows while paused (what Start would book). */
	context: TimerContext;
	/** chatId → subject Paul chose by hand. */
	chatSubjects: Record<string, string>;
	/** Why the last run ended on its own, until the next start. */
	stopped?: "idle" | "asleep" | null;
}

export const emptyTimerState = (): TimerState => ({
	version: 1,
	pieces: [],
	running: null,
	context: { subject: null, chatId: null },
	chatSubjects: {},
	stopped: null,
});

// ─── Subject ────────────────────────────────────────────────────────────────

/** What the timer needs to know about where a chat belongs. */
export interface SubjectSources {
	/** chatId → exam name, for focus sessions of Klausur-Aufträge. */
	examByChat: ReadonlyMap<string, string>;
	organization?: SourceOrganization;
	chatSubjects: Readonly<Record<string, string>>;
}

/** Name of the top-level folder a chat sits in, or null at the root. */
export function topFolderName(organization: SourceOrganization | undefined, chatId: string): string | null {
	if (!organization) return null;
	const seen = new Set<string>();
	let folderId = organization.placements[chatId]?.folderId ?? null;
	let top: string | null = null;
	while (folderId && !seen.has(folderId)) {
		seen.add(folderId);
		const folder = organization.folders.find((f) => f.id === folderId);
		if (!folder) break;
		top = folder.name;
		folderId = folder.parentId;
	}
	return top?.trim() || null;
}

export function subjectForChat(chatId: string | null, src: SubjectSources): string | null {
	if (!chatId) return null;
	const own = src.chatSubjects[chatId]?.trim();
	if (own) return own;
	return src.examByChat.get(chatId) ?? topFolderName(src.organization, chatId);
}

/** Subjects to offer in the picker: exams, top-level folders, hand-picked
 *  ones. An exam's own folder ("FODS Theorie Klausur") is not offered — its
 *  sessions already count for the exam. */
export function subjectChoices(src: SubjectSources): string[] {
	const names = new Set<string>();
	const examFolders = new Set<string>();
	for (const exam of src.examByChat.values()) {
		names.add(exam);
		examFolders.add(examFolderName({ exam }));
	}
	for (const f of src.organization?.folders ?? []) {
		const name = f.name.trim();
		if (!f.parentId && name && !examFolders.has(name)) names.add(name);
	}
	for (const s of Object.values(src.chatSubjects)) if (s.trim()) names.add(s.trim());
	return [...names].sort((a, b) => a.localeCompare(b));
}

// ─── Transitions (all pure: state in, new state out) ───────────────────────

function close(state: TimerState, at: number): TimerState {
	const r = state.running;
	if (!r) return state;
	const end = Math.max(r.start, at);
	const pieces = end - r.start >= MIN_PIECE_MS
		? [...state.pieces, { subject: r.subject, chatId: r.chatId, start: r.start, end }].slice(-MAX_PIECES)
		: state.pieces;
	return { ...state, pieces, running: null, context: { subject: r.subject, chatId: r.chatId } };
}

/**
 * Bring the state up to `now`: a missed heartbeat means sleep/quit/crash,
 * a long stretch without input means idle. Either ends the piece at the
 * last moment that was really learning. Runs before every other action.
 */
export function settle(state: TimerState, now: number): TimerState {
	const r = state.running;
	if (!r) return state;
	const idleEnd = r.activeAt + IDLE_PAUSE_MS;
	const staleEnd = r.beatAt + STALE_MS;
	if (now < idleEnd && now < staleEnd) return state;
	// Whichever came first decides; idle never books past the last input.
	if (idleEnd <= staleEnd) return { ...close(state, Math.min(r.activeAt, r.beatAt)), stopped: "idle" };
	// Asleep: book up to the last beat — unless the timer was already asking
	// "Still there?" then, in which case that unanswered stretch is idle too.
	const end = r.beatAt - r.activeAt >= IDLE_ASK_MS ? r.activeAt : r.beatAt;
	return { ...close(state, end), stopped: "asleep" };
}

export function start(state: TimerState, now: number, ctx: TimerContext = state.context): TimerState {
	const s = settle(state, now);
	if (s.running) return s;
	return { ...s, context: ctx, stopped: null, running: { ...ctx, start: now, beatAt: now, activeAt: now } };
}

export function pause(state: TimerState, now: number): TimerState {
	const s = settle(state, now);
	return s.running ? { ...close(s, now), stopped: null } : s;
}

/** A heartbeat from the window, with the time of the last input. A late
 *  beat (sleep) settles first; otherwise the reported input counts before
 *  the idle check, so coming back at 19 min is not paused at 20. */
export function beat(state: TimerState, now: number, activeAt: number): TimerState {
	const r = state.running;
	if (!r) return state;
	if (now >= r.beatAt + STALE_MS) return settle(state, now);
	const active = Math.min(now, Math.max(r.activeAt, activeAt));
	return settle({ ...state, running: { ...r, beatAt: now, activeAt: active } }, now);
}

/**
 * The window shows another chat (or none). Running: the old piece ends and
 * a new one starts now in the new context — only when the context really
 * changed. Paused: the shown context follows, so Start books correctly.
 * `chatId === null` (graph, settings) keeps the current context.
 */
export function switchContext(state: TimerState, now: number, ctx: TimerContext): TimerState {
	const s = settle(state, now);
	if (ctx.chatId === null) return s;
	const current = s.running ?? s.context;
	if (current.chatId === ctx.chatId && current.subject === ctx.subject) return s;
	if (!s.running) return { ...s, context: ctx };
	const { activeAt } = s.running;
	const next = close(s, now);
	return { ...next, context: ctx, running: { ...ctx, start: now, beatAt: now, activeAt: Math.max(activeAt, now) } };
}

/**
 * Paul picks a subject for a chat by hand. Remembered for that chat; the
 * running piece of the same chat is relabelled from its start (it is the
 * same stretch of learning, just named now), earlier pieces stay as booked.
 */
export function assignSubject(state: TimerState, now: number, chatId: string | null, subject: string | null): TimerState {
	const s = settle(state, now);
	const name = subject?.trim() || null;
	const chatSubjects = { ...s.chatSubjects };
	if (chatId) {
		if (name) chatSubjects[chatId] = name;
		else delete chatSubjects[chatId];
	}
	const relabel = <T extends TimerContext>(c: T): T => (c.chatId === chatId ? { ...c, subject: name } : c);
	return {
		...s,
		chatSubjects,
		context: relabel(s.context),
		running: s.running ? relabel(s.running) : null,
	};
}

// ─── Reading it back ────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (ms: number) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Next local midnight after `ms`. */
const nextMidnight = (ms: number) => {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

/** All pieces, the running one up to `now` included. */
export function allPieces(state: TimerState, now: number): TimerPiece[] {
	const r = state.running;
	return r ? [...state.pieces, { subject: r.subject, chatId: r.chatId, start: r.start, end: Math.max(r.start, now) }] : state.pieces;
}

/** Split a piece at local midnights: [day, ms][]. */
export function splitByDay(piece: Pick<TimerPiece, "start" | "end">): Array<[string, number]> {
	const out: Array<[string, number]> = [];
	let from = piece.start;
	while (from < piece.end) {
		const to = Math.min(piece.end, nextMidnight(from));
		out.push([dayOf(from), to - from]);
		from = to;
	}
	return out;
}

/** Milliseconds per local day, for the pieces that pass `keep`. */
export function msByDay(pieces: readonly TimerPiece[], keep: (p: TimerPiece) => boolean = () => true): Map<string, number> {
	const out = new Map<string, number>();
	for (const p of pieces) {
		if (!keep(p)) continue;
		for (const [day, ms] of splitByDay(p)) out.set(day, (out.get(day) ?? 0) + ms);
	}
	return out;
}

/** chatId → (day → ms): what the export merges into its estimates. */
export function msByChatDay(pieces: readonly TimerPiece[]): Map<string, Map<string, number>> {
	const out = new Map<string, Map<string, number>>();
	for (const p of pieces) {
		if (!p.chatId) continue;
		const days = out.get(p.chatId) ?? new Map<string, number>();
		for (const [day, ms] of splitByDay(p)) days.set(day, (days.get(day) ?? 0) + ms);
		out.set(p.chatId, days);
	}
	return out;
}

/** day → subject → ms, for days on or after `since`. */
export function msBySubjectDay(pieces: readonly TimerPiece[], since: string): Map<string, Map<string, number>> {
	const out = new Map<string, Map<string, number>>();
	for (const p of pieces) {
		const subject = p.subject ?? NO_SUBJECT;
		for (const [day, ms] of splitByDay(p)) {
			if (day < since) continue;
			const subjects = out.get(day) ?? new Map<string, number>();
			subjects.set(subject, (subjects.get(subject) ?? 0) + ms);
			out.set(day, subjects);
		}
	}
	return out;
}

/** What the floating timer shows: today's measured time in the shown subject. */
export function todayForSubject(state: TimerState, now: number, subject: string | null): number {
	const today = dayOf(now);
	return msByDay(allPieces(state, now), (p) => p.subject === subject).get(today) ?? 0;
}

/** Validate a stored state; anything malformed falls back to empty pieces. */
export function parseTimerState(raw: unknown): TimerState {
	const base = emptyTimerState();
	const r = raw as Partial<TimerState> | null;
	if (!r || r.version !== 1) return base;
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
	const ctx = (v: unknown): TimerContext => {
		const c = (v ?? {}) as Partial<TimerContext>;
		return { subject: str(c.subject), chatId: str(c.chatId) };
	};
	const pieces = Array.isArray(r.pieces)
		? r.pieces.flatMap((p) => {
				const start = num(p?.start);
				const end = num(p?.end);
				return start !== null && end !== null && end > start ? [{ ...ctx(p), start, end }] : [];
			})
		: [];
	let running: RunningPiece | null = null;
	const rr = r.running as Partial<RunningPiece> | null | undefined;
	const rs = num(rr?.start);
	if (rr && rs !== null) running = { ...ctx(rr), start: rs, beatAt: num(rr.beatAt) ?? rs, activeAt: num(rr.activeAt) ?? rs };
	const chatSubjects: Record<string, string> = {};
	if (r.chatSubjects && typeof r.chatSubjects === "object") {
		for (const [k, v] of Object.entries(r.chatSubjects)) if (str(v)) chatSubjects[k] = (v as string).trim();
	}
	return {
		version: 1,
		pieces,
		running,
		context: ctx(r.context),
		chatSubjects,
		stopped: r.stopped === "idle" || r.stopped === "asleep" ? r.stopped : null,
	};
}
