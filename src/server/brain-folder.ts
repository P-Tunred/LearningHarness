/**
 * Second Brain link (fork addition) — where the brain is. Kept apart from
 * brain.ts (which needs the chat handler for imports) so the chat handler
 * can read the prompt note without an import cycle.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRAIN_EXPORT_DIR, BRAIN_WIKI_EXPORT_DIR } from "../core/brain-export.ts";
import { isBrainFolder } from "../core/settings.ts";
import { stores } from "./stores.ts";

/** The configured folder, "~/" expanded; null when unset or invalid. */
export function configuredBrainFolder(): string | null {
	const folder = stores.settingsStore.readSettings()?.brain?.folder;
	if (!isBrainFolder(folder)) return null;
	return folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(2)) : folder;
}

export function usableFolder(folder: string): string | null {
	try {
		const real = fs.realpathSync(folder);
		return fs.statSync(real).isDirectory() ? real : null;
	} catch {
		return null;
	}
}

/** Brain-relative export folder: inside `wiki/` when the brain has one, so
 *  the VM mirror (wiki/ only) carries it to Hermes and the dashboard. */
export function exportDirFor(brainRoot: string): string {
	try {
		if (fs.statSync(path.join(brainRoot, "wiki")).isDirectory()) return BRAIN_WIKI_EXPORT_DIR;
	} catch { /* no wiki/ */ }
	return BRAIN_EXPORT_DIR;
}

/** The prompt note that tells the agents where the brain is, or null when
 *  no usable folder is configured. Stable text per folder (prompt cache). */
export function brainPromptNote(): string | null {
	const configured = configuredBrainFolder();
	const root = configured ? usableFolder(configured) : null;
	if (!root) return null;
	const hasWiki = exportDirFor(root) === BRAIN_WIKI_EXPORT_DIR;
	const base = hasWiki ? path.join(root, "wiki") : root;
	return [
		"## His Second Brain",
		"",
		`He keeps a personal knowledge base of Markdown pages (in German) at \`${base}\`. It knows his courses, exams, deadlines, plans and what he has worked on before.`,
		hasWiki
			? "`index.md` lists every page with one sentence; `start.md` is his current overview; courses and projects live in `themen/`, terms and methods in `konzepte/`."
			: "Use `ls` and `grep` to find the relevant notes.",
		"When a lesson touches a course, an exam, a deadline or earlier work, look it up there with `grep`/`read` instead of asking him. Read-only: never write there. Use only what bears on what he is learning; personal pages (people, money, private plans) are not lesson material.",
	].join("\n");
}
