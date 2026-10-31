/**
 * Klausur-Aufträge (fork addition) — the IO half of src/core/exam-plan.ts.
 *
 * At start-up (inside the brain sync) every `.md` in
 * `<brain>/LearnHarness/Auftraege/` is read. Each focus that has no session
 * yet gets one: titled after the focus, stamped with the strong model like
 * a session started from home, placed in the folder "<Klausur> Klausur".
 * Its opening prompt is remembered here and served to the chat page, which
 * sends it the first time Paul opens the session (app/chat/[id]/page.tsx).
 *
 * The plan file stays where it is, so Claude can extend it: a NEW focus
 * becomes a new session at the next start; existing sessions are never
 * touched or duplicated, even if Paul deleted one. Bookkeeping lives in the
 * LearnHarness data folder (klausur-auftraege.json), never in the brain.
 */
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	EXAM_PLANS_DIR,
	ExamPlanError,
	examFolderName,
	focusKey,
	openingPrompt,
	parseExamPlan,
	type ExamPlan,
	type ExamWeight,
} from "../core/exam-plan.ts";
import { localDay } from "../core/brain-export.ts";
import { sourceDirectory } from "./source-organization.ts";
import { stores } from "./stores.ts";

export const EXAM_STATE_FILE = path.join(PATHS.data, "klausur-auftraege.json");
const MAX_PLAN_BYTES = 256 * 1024;

interface PlanState {
	exam: string;
	date: string | null;
	hoursPerWeek?: number | null;
	reviewFrom?: string | null;
	/** First day LearnHarness read the plan — the start of the progress line. */
	since?: string;
	folderId: string | null;
	/** focusKey → the session created for it, with the focus as last read. */
	sessions: Record<string, { chatId: string; title: string; weight: ExamWeight | null; effortHours?: number | null }>;
	error?: string;
}

interface ExamState {
	version: 1;
	/** The resolved brain folder this state belongs to. */
	folder: string;
	/** Plan file name (inside Auftraege/) → what was created from it. */
	plans: Record<string, PlanState>;
	/** chatId → opening prompt, until the session has a conversation. */
	openings: Record<string, string>;
}

function readState(folder?: string): ExamState {
	try {
		const raw = JSON.parse(fs.readFileSync(EXAM_STATE_FILE, "utf-8")) as Partial<ExamState>;
		if (raw?.version === 1 && raw.plans && raw.openings && typeof raw.folder === "string" && (folder === undefined || raw.folder === folder)) {
			return { version: 1, folder: raw.folder, plans: { ...raw.plans }, openings: { ...raw.openings } };
		}
	} catch { /* first run */ }
	return { version: 1, folder: folder ?? "", plans: {}, openings: {} };
}

function saveState(state: ExamState): void {
	fs.mkdirSync(path.dirname(EXAM_STATE_FILE), { recursive: true });
	const tmp = `${EXAM_STATE_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
	fs.renameSync(tmp, EXAM_STATE_FILE);
}

/** Plan files (top level of Auftraege/, Markdown, not hidden). Exported for tests. */
export function scanExamPlans(root: string): string[] {
	try {
		return fs.readdirSync(path.join(root, ...EXAM_PLANS_DIR.split("/")), { withFileTypes: true })
			.filter((e) => e.isFile() && !e.name.startsWith(".") && /\.(?:md|markdown)$/i.test(e.name))
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

/** The plan's folder: the remembered one while it still exists, else a new one. */
function ensureFolder(plan: ExamPlan, previous: string | null): string {
	if (previous && stores.sourceOrganizationStore.read().folders.some((f) => f.id === previous)) return previous;
	const created = sourceDirectory.change({ action: "create-folder", name: examFolderName(plan), parentId: null }).createdFolderId;
	if (!created) throw new Error("Ordner für die Klausur konnte nicht angelegt werden.");
	return created;
}

function createFocusSession(title: string): string {
	const chat = stores.chatStore.createChat(title);
	const strong = stores.settingsStore.readSettings()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	return chat.id;
}

export interface ExamSyncResult {
	plans: number;
	created: number;
	errors: string[];
}

/** Read every plan and create the sessions it still lacks. */
export function syncExamPlans(root: string): ExamSyncResult {
	const state = readState(root);
	state.folder = root;
	const result: ExamSyncResult = { plans: 0, created: 0, errors: [] };
	for (const file of scanExamPlans(root)) {
		const full = path.join(root, ...EXAM_PLANS_DIR.split("/"), file);
		const previous = state.plans[file];
		let plan: ExamPlan;
		try {
			if (fs.statSync(full).size > MAX_PLAN_BYTES) throw new ExamPlanError("Der Auftrag ist zu groß.");
			plan = parseExamPlan(fs.readFileSync(full, "utf-8"), file.replace(/\.(?:md|markdown)$/i, ""));
		} catch (err) {
			const message = `${file}: ${err instanceof Error ? err.message : String(err)}`;
			result.errors.push(message);
			if (previous) state.plans[file] = { ...previous, error: message };
			continue;
		}
		result.plans++;
		const since = previous?.since ?? firstSessionDay(previous?.sessions) ?? localDay(Date.now());
		const entry: PlanState = { exam: plan.exam, date: plan.date, hoursPerWeek: plan.hoursPerWeek, reviewFrom: plan.reviewFrom, since, folderId: previous?.folderId ?? null, sessions: { ...previous?.sessions } };
		const missing = plan.focuses.filter((f) => !entry.sessions[focusKey(f.title)]);
		if (missing.length) entry.folderId = ensureFolder(plan, entry.folderId);
		for (const focus of plan.focuses) {
			const key = focusKey(focus.title);
			const known = entry.sessions[key];
			if (known) {
				entry.sessions[key] = { ...known, weight: focus.weight, effortHours: focus.effortHours };
				continue;
			}
			const chatId = createFocusSession(focus.title);
			sourceDirectory.change({ action: "move", kind: "source", id: chatId, parentId: entry.folderId });
			state.openings[chatId] = openingPrompt(plan, focus, full);
			entry.sessions[key] = { chatId, title: focus.title, weight: focus.weight, effortHours: focus.effortHours };
			result.created++;
		}
		state.plans[file] = entry;
	}
	saveState(state);
	return result;
}

/** Plans read before `since` existed start on the day their first session
 *  was created. */
function firstSessionDay(sessions: PlanState["sessions"] | undefined): string | null {
	const days = Object.values(sessions ?? {})
		.map((s) => Date.parse(stores.chatStore.getChat(s.chatId)?.createdAt ?? ""))
		.filter((ms) => Number.isFinite(ms))
		.map((ms) => localDay(ms));
	return days.length ? days.sort()[0]! : null;
}

/** The opening prompt a plan left for this session, while it still has no
 *  conversation (the chat page sends it on first open). */
export function examOpeningPrompt(chatId: string): string | undefined {
	const prompt = readState().openings[chatId];
	if (!prompt) return undefined;
	const chat = stores.chatStore.getChat(chatId);
	if (!chat || chat.messages.some((m) => m.role === "user" || m.role === "assistant")) return undefined;
	return prompt;
}

export interface ExamOverview {
	exam: string;
	date: string | null;
	hoursPerWeek: number | null;
	reviewFrom: string | null;
	planStart: string | null;
	focuses: Array<{ title: string; weight: ExamWeight | null; effortHours: number | null; chatId: string }>;
}

/** The plans as the export needs them (pure data; no stats here). */
export function examOverviews(root: string): ExamOverview[] {
	const state = readState(root);
	return Object.values(state.plans)
		.map((p) => ({
			exam: p.exam,
			date: p.date,
			hoursPerWeek: p.hoursPerWeek ?? null,
			reviewFrom: p.reviewFrom ?? null,
			planStart: p.since ?? firstSessionDay(p.sessions),
			focuses: Object.values(p.sessions).map((s) => ({ ...s, effortHours: s.effortHours ?? null })),
		}))
		.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.exam.localeCompare(b.exam));
}
