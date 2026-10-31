/**
 * Second Brain link (fork addition) — the IO half of src/core/brain-export.ts.
 *
 * - EXPORT: writes `<brain>/LearnHarness/…` (session notes, proposition
 *   notes, learnharness-stats.json). Runs after the start-up import and,
 *   debounced, whenever sessions or the graph change. Only files listed in
 *   its own manifest are ever overwritten or removed; a removal also needs
 *   the file to be unchanged since LearnHarness wrote it.
 * - IMPORT: once per app start, every .md note in the brain except the
 *   export folder and hidden folders goes through the SAME notes-import
 *   pipeline as the manual import — on the first run all of them, later
 *   only new or changed ones (content hash). Its bookkeeping lives in the
 *   LearnHarness data folder (brain-sync.json), never in the brain.
 *
 * Single-process coordination over files, like the rest of the app.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	BRAIN_EXPORT_DIR,
	BRAIN_SOURCE_PREFIX,
	brainImportCandidate,
	buildBrainExport,
} from "../core/brain-export.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import { emit, subscribe } from "../core/events.ts";
import { getGraph } from "../core/graph.ts";
import { isBrainFolder, ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import { NotesImportError } from "../agent/subagents/extraction.ts";
import { MAX_IMPORT_BYTES } from "../../lib/notes-import-limits.ts";
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
	/** Exported paths skipped because a file LearnHarness did not create is there. */
	conflicts?: string[];
	import?: { total: number; done: number; failed: number; current?: string; finishedAt?: string };
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

export function brainStatus(): BrainStatus {
	return { ...runtime().status };
}

function setStatus(patch: Partial<BrainStatus>): void {
	const rt = runtime();
	// No event here: activity-changed is a graph-change trigger for the
	// export below, so emitting it from our own status would loop.
	rt.status = { ...rt.status, ...patch };
}

// ─── Folder resolution ───────────────────────────────────────────────────────

/** The configured folder, "~/" expanded; null when unset or invalid. */
export function configuredBrainFolder(): string | null {
	const folder = stores.settingsStore.readSettings()?.brain?.folder;
	if (!isBrainFolder(folder)) return null;
	return folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
}

function usableFolder(folder: string): string | null {
	try {
		const real = fs.realpathSync(folder);
		return fs.statSync(real).isDirectory() ? real : null;
	} catch {
		return null;
	}
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

/** Export everything into `<brainRoot>/LearnHarness/`. Exported for tests. */
export function exportToBrain(brainRoot: string, now = new Date()): ExportResult {
	const exportDir = path.join(brainRoot, BRAIN_EXPORT_DIR);
	const { files } = buildBrainExport({
		chats: readAllChats(),
		graph: getGraph(stores.graphStore),
		sources: stores.graphStore.readSources(),
		now: now.toISOString(),
	});
	const previous = readManifest(exportDir);
	const next: Manifest = { version: 1, files: {} };
	const result: ExportResult = { written: 0, unchanged: 0, removed: 0, conflicts: [] };

	for (const [rel, content] of files) {
		const target = path.join(brainRoot, rel);
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
	// (renamed session, deleted proposition) — only when still untouched.
	for (const [rel, hash] of Object.entries(previous.files)) {
		if (next.files[rel] !== undefined) continue;
		const target = path.join(brainRoot, rel);
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

// ─── Import ──────────────────────────────────────────────────────────────────

interface SyncState {
	version: 1;
	/** The resolved brain folder this state belongs to; another folder starts fresh. */
	folder: string;
	/** Brain-relative path → { sha256 of the imported content, outcome }. */
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

/** Every import candidate under the brain, as POSIX-style relative paths.
 *  Symlinks are not followed. Exported for tests. */
export function scanBrain(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, relDir: string) => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || (!relDir && entry.name === BRAIN_EXPORT_DIR)) continue;
				walk(path.join(dir, entry.name), rel);
			} else if (entry.isFile() && brainImportCandidate(rel)) {
				out.push(rel);
			}
		}
	};
	walk(root, "");
	return out.sort();
}

/** Import new/changed notes. Stops early (and says why) when models or keys
 *  are missing, so a misconfiguration never burns through the whole brain. */
async function importFromBrain(root: string): Promise<void> {
	const state = readSyncState(root);
	const pending: Array<{ rel: string; text: string; hash: string }> = [];
	for (const rel of scanBrain(root)) {
		const file = path.join(root, rel);
		let bytes: Buffer;
		try {
			if (fs.statSync(file).size > MAX_IMPORT_BYTES) continue;
			bytes = fs.readFileSync(file);
		} catch { continue; }
		const text = bytes.toString("utf-8");
		if (!text.trim()) continue;
		const hash = sha256(bytes);
		if (state.files[rel]?.sha256 === hash) continue;
		pending.push({ rel, text, hash });
	}
	if (pending.length === 0) {
		setStatus({ import: { total: 0, done: 0, failed: 0, finishedAt: new Date().toISOString() } });
		return;
	}
	let done = 0;
	let failed = 0;
	setStatus({ phase: "importing", import: { total: pending.length, done, failed } });
	for (const item of pending) {
		setStatus({ import: { total: pending.length, done, failed, current: item.rel } });
		const filePath = `${BRAIN_SOURCE_PREFIX}${item.rel}`;
		try {
			sourceDirectory.registerImport(filePath);
			await extraction.importNotes({ filePath, text: item.text });
			state.files[item.rel] = { sha256: item.hash, outcome: "completed" };
		} catch (err) {
			if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
				throw new Error("Import angehalten: In LearnHarness sind noch keine Modelle bzw. Keys eingerichtet.", { cause: err });
			}
			if (err instanceof NotesImportError && (err.outcome === "busy" || err.outcome === "aborted")) {
				// Not recorded: tried again at the next start.
			} else {
				failed++;
				// Recorded with its hash so an unchanged failing note is not re-billed every start.
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
		exportedFiles: result.written + result.unchanged,
		conflicts: result.conflicts,
	});
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

/** Import (new/changed notes) then export. `force` re-runs it after the
 *  folder setting changed; otherwise it runs once per app start. */
export function startBrainSync(options: { force?: boolean } = {}): Promise<void> {
	const rt = runtime();
	if (!rt.unsubscribe) {
		rt.unsubscribe = subscribe((event) => {
			if (event.type === "turn-settled" || event.type === "chats-changed" || event.type === "record-changed") scheduleExport();
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
			await importFromBrain(root);
			runExport(root);
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			setStatus({ phase: "error", error });
			// Still export what exists so the brain reflects the sessions.
			try { runExport(root); } catch { /* reported below */ }
			setStatus({ phase: "error", error });
		}
	});
}
