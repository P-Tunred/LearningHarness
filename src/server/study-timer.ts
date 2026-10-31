/**
 * Study timer (fork addition) — the stored half. The arithmetic and the
 * rules live in src/core/study-timer.ts; this module keeps the state in
 * `study-timer.json` in the LearnHarness data folder, resolves which
 * subject a chat belongs to, and answers the floating timer.
 *
 * Every change is written at once (atomic rename), the running piece on
 * every heartbeat too — a crash or a quit loses at most one beat, and the
 * next read ends that piece at its last beat (see `settle`).
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import {
	IDLE_ASK_MS,
	assignSubject,
	beat,
	emptyTimerState,
	parseTimerState,
	pause,
	settle,
	start,
	subjectChoices,
	subjectForChat,
	switchContext,
	todayForSubject,
	type SubjectSources,
	type TimerState,
} from "../core/study-timer.ts";
import { configuredBrainFolder, usableFolder } from "./brain-folder.ts";
import { examOverviews } from "./exam-plans.ts";
import { stores } from "./stores.ts";

export const STUDY_TIMER_FILE = path.join(PATHS.data, "study-timer.json");

export function readTimerState(): TimerState {
	try {
		return parseTimerState(JSON.parse(fs.readFileSync(STUDY_TIMER_FILE, "utf-8")));
	} catch {
		return emptyTimerState(); // first run, or unreadable: start clean
	}
}

function writeTimerState(state: TimerState): void {
	fs.mkdirSync(path.dirname(STUDY_TIMER_FILE), { recursive: true });
	const tmp = `${STUDY_TIMER_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, "utf-8");
	fs.renameSync(tmp, STUDY_TIMER_FILE);
}

/** Where chats belong: exam focus sessions, folders, Paul's own picks. */
function subjectSources(state: TimerState): SubjectSources {
	const examByChat = new Map<string, string>();
	const configured = configuredBrainFolder();
	const root = configured ? usableFolder(configured) : null;
	if (root) {
		for (const exam of examOverviews(root)) for (const f of exam.focuses) examByChat.set(f.chatId, exam.exam);
	}
	return { examByChat, organization: stores.sourceOrganizationStore.read(), chatSubjects: state.chatSubjects };
}

/** What the floating timer shows. */
export interface TimerView {
	running: boolean;
	subject: string | null;
	chatId: string | null;
	/** Today's measured time in the shown subject, ms. */
	todayMs: number;
	/** Start of the running piece (the window ticks from here), or null. */
	runningSince: number | null;
	/** Time of the last input the server knows of, while running. */
	activeAt: number | null;
	/** True once the timer should ask "Still there?". */
	askIdle: boolean;
	/** Why the last run ended on its own (shown once, quietly). */
	stopped: "idle" | "asleep" | null;
	choices: string[];
	now: number;
}

function view(state: TimerState, now: number, sources: SubjectSources): TimerView {
	const shown = state.running ?? state.context;
	return {
		running: !!state.running,
		subject: shown.subject,
		chatId: shown.chatId,
		todayMs: todayForSubject(state, now, shown.subject),
		runningSince: state.running?.start ?? null,
		activeAt: state.running?.activeAt ?? null,
		askIdle: !!state.running && now - state.running.activeAt >= IDLE_ASK_MS,
		stopped: state.stopped ?? null,
		choices: subjectChoices(sources),
		now,
	};
}

/** Persist when something changed; tell other windows when the run did. */
function commit(before: TimerState, after: TimerState): void {
	if (after === before) return;
	writeTimerState(after);
	const runChanged = !!before.running !== !!after.running
		|| before.running?.subject !== after.running?.subject
		|| before.running?.chatId !== after.running?.chatId
		|| before.context.subject !== after.context.subject
		|| before.pieces.length !== after.pieces.length;
	if (runChanged) emit("study-timer-changed", {});
}

/** GET: the timer for the chat on screen (null = not in a chat). A read
 *  also settles a run that missed its heartbeats (sleep, quit, crash).
 *  The chat on screen is the truth: paused, it is what Start would book;
 *  running (a reload, an app start on another chat), the run moves to it. */
export function studyTimerView(chatId: string | null, now = Date.now()): TimerView {
	const before = readTimerState();
	let state = settle(before, now);
	const sources = subjectSources(state);
	if (chatId) state = switchContext(state, now, { chatId, subject: subjectForChat(chatId, sources) });
	commit(before, state);
	return view(state, now, sources);
}

export type TimerAction =
	| { action: "start" | "toggle" | "switch"; chatId?: string | null }
	| { action: "pause" }
	| { action: "beat"; activeAt: number }
	| { action: "assign"; chatId: string | null; subject: string | null };

export class TimerActionError extends Error {}

/** POST: one action, applied to the stored state. */
export function studyTimerAction(input: TimerAction, now = Date.now()): TimerView {
	const before = readTimerState();
	let state = before;
	const sources = () => subjectSources(state);
	const contextFor = (chatId: string | null | undefined) =>
		chatId ? { chatId, subject: subjectForChat(chatId, sources()) } : null;
	switch (input.action) {
		case "start": {
			const ctx = contextFor(input.chatId);
			state = start(ctx ? switchContext(state, now, ctx) : state, now);
			break;
		}
		case "toggle": {
			const settled = settle(state, now);
			if (settled.running) state = pause(settled, now);
			else {
				const ctx = contextFor(input.chatId);
				state = start(ctx ? switchContext(settled, now, ctx) : settled, now);
			}
			break;
		}
		case "pause":
			state = pause(state, now);
			break;
		case "switch": {
			const ctx = contextFor(input.chatId);
			state = ctx ? switchContext(state, now, ctx) : settle(state, now);
			break;
		}
		case "beat":
			if (!Number.isFinite(input.activeAt)) throw new TimerActionError("activeAt must be a timestamp");
			state = beat(state, now, input.activeAt);
			break;
		case "assign":
			state = assignSubject(state, now, input.chatId, input.subject);
			break;
		default:
			throw new TimerActionError("unknown action");
	}
	commit(before, state);
	return view(state, now, subjectSources(state));
}

/** Parse a request body into an action, or throw TimerActionError. */
export function parseTimerAction(body: unknown): TimerAction {
	const b = (body ?? {}) as Record<string, unknown>;
	const chatId = typeof b.chatId === "string" && b.chatId.trim() ? b.chatId.trim() : null;
	switch (b.action) {
		case "start":
		case "toggle":
		case "switch":
			return { action: b.action, chatId };
		case "pause":
			return { action: "pause" };
		case "beat":
			if (typeof b.activeAt !== "number") throw new TimerActionError("beat needs activeAt");
			return { action: "beat", activeAt: b.activeAt };
		case "assign": {
			if (b.subject !== null && typeof b.subject !== "string") throw new TimerActionError("subject must be a string or null");
			const subject = typeof b.subject === "string" ? b.subject.trim().slice(0, 120) || null : null;
			return { action: "assign", chatId, subject };
		}
		default:
			throw new TimerActionError("action must be start, toggle, switch, pause, beat or assign");
	}
}
