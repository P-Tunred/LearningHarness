/**
 * Second Brain link (fork addition) — the IO half of src/core/brain-export.ts.
 *
 * - EXPORT: writes the coarse overview (lernstand.md) and the dashboard
 *   stats into `<brain>/wiki/learnharness/` (or `<brain>/LearnHarness/` for
 *   a brain without `wiki/`). Runs after the start-up inbox import and,
 *   debounced, whenever sessions or the graph change. Only files listed in
 *   its own manifest are ever overwritten or removed; a removal also needs
 *   the file to be unchanged since LearnHarness wrote it.
 * - INBOX: documents (Markdown, text, PDF) that Paul, Hermes or Claude put
 *   into `<brain>/LearnHarness/Eingang/` go through the SAME notes-import
 *   pipeline as the manual import, then move to `Eingang/importiert/`. The
 *   rest of the brain is NOT imported — the graph holds what he learns.
 * - READ ACCESS: the teaching agents get a short prompt note saying where
 *   the brain is (brainPromptNote); they read it with their read-only file
 *   tools when a lesson needs context.
 *
 * Single-process coordination over files, like the rest of the app.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	BRAIN_EXPORT_DIR,
	BRAIN_INBOX_DIR,
	BRAIN_INBOX_DONE_DIR,
	BRAIN_SOURCE_PREFIX,
	buildBrainExport,
	inboxImportCandidate,
	localDay,
	summarizeExams,
} from "../core/brain-export.ts";
import { examProgress, minutesTodayAndWeek, type ExamProgress } from "../core/exam-progress.ts";
import { allPieces, settle } from "../core/study-timer.ts";
import { questionLedger, type OpenQuestion } from "../core/open-questions.ts";
import { readTimerState } from "./study-timer.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import { emit, subscribe } from "../core/events.ts";
import { getGraph } from "../core/graph.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { NotesImportError } from "../agent/subagents/extraction.ts";
import { MAX_IMPORT_BYTES } from "../../lib/notes-import-limits.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { configuredBrainFolder, exportDirFor, usableFolder } from "./brain-folder.ts";
import { examOverviews, syncExamPlans } from "./exam-plans.ts";
import { reviewSubjects, type SubjectReviewOutcome } from "./subject-review.ts";
import { extraction } from "./chat-handler.ts";
import { sourceDirectory } from "./source-organization.ts";
import { stores } from "./stores.ts";

export const BRAIN_SYNC_STATE_FILE = path.join(PATHS.data, "brain-sync.json");
const MANIFEST_NAME = ".learnharness-export.json";
const EXPORT_DEBOUNCE_MS = 5_000;

// ─── Status (shown in Settings → Second Brain) ───────────────────────────────

export interface BrainStatus {
	folder: string | null;
	phase: "off" | "idle" | "importing" | "exporting" | "error";
	error?: string;
	lastExportAt?: string;
	exportedFiles?: number;
	/** Brain-relative folder the overview and stats go to. */
	exportDir?: string;
	/** Exported paths skipped because a file LearnHarness did not create is there. */
	conflicts?: string[];
	import?: { total: number; done: number; failed: number; current?: string; finishedAt?: string };
	/** Klausur-Aufträge read at the last start. */
	exams?: { plans: number; created: number; errors: string[] };
	/** Fach-Überprüfung: the subject being reviewed now, and the last outcomes. */
	subjects?: { running: string | null; outcomes: SubjectReviewOutcome[]; finishedAt?: string };
}

interface BrainGlobal {
	__lhBrain?: {
		status: BrainStatus;
		started: boolean;
		running: Promise<void> | null;
		exportTimer: ReturnType<typeof setTimeout> | null;
		unsubscribe: (() => void) | null;
	};
}

function runtime() {
	const g = globalThis as BrainGlobal;
	g.__lhBrain ??= { status: { folder: null, phase: "off" }, started: false, running: null, exportTimer: null, unsubscribe: null };
	return g.__lhBrain;
}

/** The study timer's pieces, a run that missed its beats settled, the
 *  running piece cut at `now` (read-only: settling is persisted by the
 *  timer's own reads, not by the export). */
function timerPiecesAt(now: number) {
	return allPieces(settle(readTimerState(), now), now);
}

/** Where Paul stands on each exam plan right now (the sidebar's progress
 *  strip). Empty without a usable brain folder or without plans. */
export function examProgressNow(now = new Date()): ExamProgress[] {
	const configured = configuredBrainFolder();
	const root = configured ? usableFolder(configured) : null;
	if (!root) return [];
	const overviews = examOverviews(root);
	if (overviews.length === 0) return [];
	const today = localDay(now.getTime());
	const exams = summarizeExams(overviews, readAllChats(), undefined, timerPiecesAt(now.getTime()));
	const allFocuses = exams.flatMap((e) => e.focuses);
	return exams.map((exam) => {
		const minutes = minutesTodayAndWeek(exam.minutesByDay, today);
		return examProgress({ exam, planStart: exam.planStart, today, minutesToday: minutes.today, minutesWeek: minutes.week, allFocuses });
	});
}

export function brainStatus(): BrainStatus {
	return { ...runtime().status };
}

function setStatus(patch: Partial<BrainStatus>): void {
	const rt = runtime();
	// No event here: activity-changed is a graph-change trigger for the
	// export below, so emitting it from our own status would loop.
	rt.status = { ...rt.status, ...patch };
}

const sha256 = (text: string | Buffer) => crypto.createHash("sha256").update(text).digest("hex");

/** Write via temp file + rename so a reader (Drive sync, Obsidian) never sees half a file. */
function writeAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, content, "utf-8");
	fs.renameSync(tmp, file);
}

// ─── Export ──────────────────────────────────────────────────────────────────

interface Manifest {
	version: 1;
	/** Brain-relative path → sha256 of the content LearnHarness last wrote. */
	files: Record<string, string>;
}

function readManifest(exportDir: string): Manifest {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(exportDir, MANIFEST_NAME), "utf-8")) as Partial<Manifest>;
		if (raw && raw.version === 1 && raw.files && typeof raw.files === "object") return { version: 1, files: { ...raw.files } };
	} catch { /* first export or unreadable → start fresh */ }
	return { version: 1, files: {} };
}

/** The open questions of one chat (the exam overview's list, fetched on
 *  click so the texts never ride the export). null = no such chat. */
export function openQuestionsOf(chatId: string): OpenQuestion[] | null {
	const record = stores.chatStore.getChat(chatId);
	return record ? questionLedger(record.messages).open : null;
}

function readAllChats(): ChatRecord[] {
	const out: ChatRecord[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const record = stores.chatStore.getChat(summary.id);
		if (record) out.push(record);
	}
	return out;
}

/** Inside `root` after resolution (guards against odd relative paths). */
function inside(root: string, file: string): boolean {
	const rel = path.relative(root, file);
	return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface ExportResult {
	written: number;
	unchanged: number;
	removed: number;
	conflicts: string[];
}

/** Export the overview + stats into the brain. Exported for tests. */
export function exportToBrain(brainRoot: string, now = new Date()): ExportResult {
	const exportRel = exportDirFor(brainRoot);
	const exportDir = path.join(brainRoot, ...exportRel.split("/"));
	const { files } = buildBrainExport({
		chats: readAllChats(),
		graph: getGraph(stores.graphStore),
		organization: stores.sourceOrganizationStore.read(),
		exams: examOverviews(brainRoot),
		timerPieces: timerPiecesAt(now.getTime()),
		timerSessions: readTimerState().sessions,
		now: now.toISOString(),
	});
	const previous = readManifest(exportDir);
	const next: Manifest = { version: 1, files: {} };
	const result: ExportResult = { written: 0, unchanged: 0, removed: 0, conflicts: [] };

	for (const [name, content] of files) {
		const rel = `${exportRel}/${name}`;
		const target = path.join(exportDir, name);
		if (!inside(exportDir, target)) continue;
		const hash = sha256(content);
		let current: string | null = null;
		try { current = fs.readFileSync(target, "utf-8"); } catch { /* new file */ }
		if (current !== null && previous.files[rel] === undefined && sha256(current) !== hash) {
			// Someone else's file sits at this path: never overwrite it.
			result.conflicts.push(rel);
			continue;
		}
		next.files[rel] = hash;
		if (current !== null && sha256(current) === hash) {
			result.unchanged++;
			continue;
		}
		writeAtomic(target, content);
		result.written++;
	}

	// Remove files LearnHarness wrote earlier that are no longer generated
	// (e.g. the per-session notes of the first version) — only when untouched.
	for (const [rel, hash] of Object.entries(previous.files)) {
		if (next.files[rel] !== undefined) continue;
		const target = path.join(brainRoot, ...rel.split("/"));
		if (!inside(exportDir, target)) continue;
		try {
			if (sha256(fs.readFileSync(target)) === hash) {
				fs.unlinkSync(target);
				result.removed++;
			}
		} catch { /* already gone */ }
	}
	writeAtomic(path.join(exportDir, MANIFEST_NAME), `${JSON.stringify(next, null, "\t")}\n`);
	return result;
}

// ─── Inbox import ────────────────────────────────────────────────────────────

interface SyncState {
	version: 1;
	/** The resolved brain folder this state belongs to; another folder starts fresh. */
	folder: string;
	/** Inbox-relative path → { sha256 of the content, outcome } for files that
	 *  stayed in the inbox (failed ones), so they are not re-billed every start. */
	files: Record<string, { sha256: string; outcome: "completed" | "failed" | "partial" }>;
}

function readSyncState(folder: string): SyncState {
	try {
		const raw = JSON.parse(fs.readFileSync(BRAIN_SYNC_STATE_FILE, "utf-8")) as Partial<SyncState>;
		if (raw && raw.version === 1 && raw.folder === folder && raw.files && typeof raw.files === "object") {
			return { version: 1, folder, files: { ...raw.files } };
		}
	} catch { /* first sync */ }
	return { version: 1, folder, files: {} };
}

function saveSyncState(state: SyncState): void {
	writeAtomic(BRAIN_SYNC_STATE_FILE, `${JSON.stringify(state, null, "\t")}\n`);
}

const inboxDir = (root: string) => path.join(root, ...BRAIN_INBOX_DIR.split("/"));

/** Every document waiting in the inbox, as POSIX-style inbox-relative
 *  paths. Symlinks are not followed. Exported for tests. */
export function scanInbox(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, relDir: string) => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || (!relDir && entry.name === BRAIN_INBOX_DONE_DIR)) continue;
				walk(path.join(dir, entry.name), rel);
			} else if (entry.isFile() && inboxImportCandidate(rel)) {
				out.push(rel);
			}
		}
	};
	walk(inboxDir(root), "");
	return out.sort();
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const MAX_PDF_PAGES = 1000;

/** A PDF becomes page-marked Markdown (as in the manual import); anything
 *  else is read as text. Null = nothing importable. */
async function documentText(bytes: Buffer): Promise<string | null> {
	if (!PDF_MAGIC.every((byte, i) => bytes[i] === byte)) return bytes.toString("utf-8");
	const pdf = await convertPdf(new Uint8Array(bytes), MAX_PDF_PAGES);
	return pdf.kind === "converted" ? joinPages(pdf.pages) || null : null;
}

/** Move an imported document to Eingang/importiert/, never over another file. */
function moveToDone(root: string, rel: string): void {
	const from = path.join(inboxDir(root), ...rel.split("/"));
	const doneDir = path.join(inboxDir(root), BRAIN_INBOX_DONE_DIR, ...rel.split("/").slice(0, -1));
	fs.mkdirSync(doneDir, { recursive: true });
	const ext = path.extname(from);
	const base = path.basename(from, ext);
	let target = path.join(doneDir, base + ext);
	for (let n = 2; fs.existsSync(target); n++) target = path.join(doneDir, `${base} (${n})${ext}`);
	fs.renameSync(from, target);
}

/** Import the documents waiting in the inbox. Stops early (and says why)
 *  when models or keys are missing, so a misconfiguration never burns
 *  through the inbox. */
async function importInbox(root: string): Promise<void> {
	const state = readSyncState(root);
	const pending: Array<{ rel: string; text: string; hash: string }> = [];
	for (const rel of scanInbox(root)) {
		const file = path.join(inboxDir(root), ...rel.split("/"));
		let bytes: Buffer;
		try {
			if (fs.statSync(file).size > MAX_IMPORT_BYTES) continue;
			bytes = fs.readFileSync(file);
		} catch { continue; }
		const hash = sha256(bytes);
		if (state.files[rel]?.sha256 === hash) continue;
		const text = await documentText(bytes).catch(() => null);
		if (!text?.trim()) {
			state.files[rel] = { sha256: hash, outcome: "failed" };
			continue;
		}
		pending.push({ rel, text, hash });
	}
	if (pending.length === 0) {
		saveSyncState(state);
		setStatus({ import: { total: 0, done: 0, failed: 0, finishedAt: new Date().toISOString() } });
		return;
	}
	let done = 0;
	let failed = 0;
	setStatus({ phase: "importing", import: { total: pending.length, done, failed } });
	for (const item of pending) {
		setStatus({ import: { total: pending.length, done, failed, current: item.rel } });
		const filePath = `${BRAIN_SOURCE_PREFIX}${BRAIN_INBOX_DIR}/${item.rel}`;
		try {
			sourceDirectory.registerImport(filePath);
			await extraction.importNotes({ filePath, text: item.text });
			delete state.files[item.rel];
			moveToDone(root, item.rel);
		} catch (err) {
			if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
				throw new Error("Import angehalten: In LearnHarness sind noch keine Modelle bzw. Keys eingerichtet.", { cause: err });
			}
			if (err instanceof NotesImportError && (err.outcome === "busy" || err.outcome === "aborted")) {
				// Not recorded: tried again at the next start.
			} else {
				failed++;
				// Recorded with its hash so an unchanged failing document is not re-billed every start.
				state.files[item.rel] = { sha256: item.hash, outcome: err instanceof NotesImportError && err.outcome === "partial" ? "partial" : "failed" };
				console.error(`[brain] import failed for ${item.rel}:`, err instanceof Error ? err.message : err);
			}
		} finally {
			done++;
			saveSyncState(state);
			emit("sources-changed", {});
		}
	}
	setStatus({ import: { total: pending.length, done, failed, finishedAt: new Date().toISOString() } });
}

// ─── Orchestration ───────────────────────────────────────────────────────────

function runExport(root: string): void {
	setStatus({ phase: "exporting" });
	const result = exportToBrain(root);
	setStatus({
		phase: "idle",
		error: undefined,
		lastExportAt: new Date().toISOString(),
		exportDir: exportDirFor(root),
		exportedFiles: result.written + result.unchanged,
		conflicts: result.conflicts,
	});
}

/** Create the sessions new Klausur-Aufträge ask for; never fatal for the sync. */
function runExamPlans(root: string): void {
	try {
		const exams = syncExamPlans(root);
		setStatus({ exams });
		if (exams.created) emit("sources-changed", {});
	} catch (err) {
		setStatus({ exams: { plans: 0, created: 0, errors: [err instanceof Error ? err.message : String(err)] } });
	}
}

function exclusive(task: () => Promise<void>): Promise<void> {
	const rt = runtime();
	const previous = rt.running ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(task);
	rt.running = next.finally(() => { if (rt.running === next) rt.running = null; });
	return next;
}

function resolveOrReport(): string | null {
	const configured = configuredBrainFolder();
	if (!configured) {
		setStatus({ folder: null, phase: "off", error: undefined });
		return null;
	}
	const root = usableFolder(configured);
	if (!root) {
		setStatus({ folder: configured, phase: "error", error: "Ordner nicht gefunden. Ist Google Drive verbunden?" });
		return null;
	}
	setStatus({ folder: root });
	return root;
}

/** Debounced export after sessions/graph changes. */
function scheduleExport(): void {
	const rt = runtime();
	if (rt.exportTimer) clearTimeout(rt.exportTimer);
	rt.exportTimer = setTimeout(() => {
		rt.exportTimer = null;
		void exclusive(async () => {
			const root = resolveOrReport();
			if (!root) return;
			try { runExport(root); } catch (err) {
				setStatus({ phase: "error", error: `Export fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` });
			}
		});
	}, EXPORT_DEBOUNCE_MS);
	rt.exportTimer.unref?.();
}

/** Import the inbox, then export. `force` re-runs it after the
 *  folder setting changed; otherwise it runs once per app start. */
/** One Fach-Überprüfung pass at a time (it is single-flight on its own). */
function startSubjectReviews(root: string): void {
	const g = globalThis as { __lhSubjectReview?: Promise<void> | null };
	if (g.__lhSubjectReview) return;
	setStatus({ subjects: { running: null, outcomes: runtime().status.subjects?.outcomes ?? [] } });
	g.__lhSubjectReview = reviewSubjects(root, {
		onSubject: (subject) => setStatus({ subjects: { running: subject, outcomes: runtime().status.subjects?.outcomes ?? [] } }),
	})
		.then((outcomes) => {
			setStatus({ subjects: { running: null, outcomes, finishedAt: new Date().toISOString() } });
			// New plans are worth a fresh overview in the brain.
			if (outcomes.some((o) => o.status === "reviewed")) scheduleExport();
		})
		.catch((err) => {
			console.error("[faecher] review pass failed:", err);
			setStatus({ subjects: { running: null, outcomes: [{ subject: "—", status: "failed", error: err instanceof Error ? err.message : String(err) }] } });
		})
		.finally(() => { g.__lhSubjectReview = null; });
}

export function startBrainSync(options: { force?: boolean } = {}): Promise<void> {
	const rt = runtime();
	if (!rt.unsubscribe) {
		rt.unsubscribe = subscribe((event) => {
			if (event.type === "turn-settled" || event.type === "chats-changed" || event.type === "record-changed") scheduleExport();
			// Study timer paused or switched: the measured time goes out too.
			if (event.type === "study-timer-changed") scheduleExport();
			// Extraction runs (graph writes) announce themselves as activity
			// changes; during the start-up import the final export covers them.
			if ((event.type === "sources-changed" || event.type === "activity-changed") && runtime().status.phase !== "importing") scheduleExport();
		});
	}
	if (rt.started && !options.force) return rt.running ?? Promise.resolve();
	rt.started = true;
	return exclusive(async () => {
		const root = resolveOrReport();
		if (!root) return;
		try {
			await importInbox(root);
			runExamPlans(root);
			runExport(root);
			// Fach-Überprüfung: model runs take minutes — in the background,
			// outside the exclusive queue, so exports are never held up.
			startSubjectReviews(root);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			setStatus({ phase: "error", error });
			// Still export what exists so the brain reflects the sessions.
			try { runExport(root); } catch { /* reported below */ }
			setStatus({ phase: "error", error });
		}
	});
}
