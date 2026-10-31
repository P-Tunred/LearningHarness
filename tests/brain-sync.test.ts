/**
 * Second Brain sync (fork addition) — the IO half against real files: a
 * temp copy of the golden data dir (LH_DATA_DIR seam, set before any store
 * import) and a temp brain folder with Paul's layout (wiki/ + raw/). The
 * notes-import pipeline is replaced by a recorder, so no model is called.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-data");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brain-data-"));
fs.cpSync(GOLDEN, DATA, { recursive: true });
process.env.LH_DATA_DIR = DATA;
const BRAIN = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brain-"));
const INBOX = path.join(BRAIN, "LearnHarness", "Eingang");
const EXPORT = path.join(BRAIN, "wiki", "learnharness");

function write(rel: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(BRAIN, rel)), { recursive: true });
	fs.writeFileSync(path.join(BRAIN, rel), text);
}
function setBrainFolder(folder: string | null) {
	const file = path.join(DATA, "settings.json");
	const record = JSON.parse(fs.readFileSync(file, "utf-8"));
	record.brain = folder === null ? {} : { folder };
	fs.writeFileSync(file, JSON.stringify(record));
}

// The rest of the brain: must never reach the graph.
write("wiki/themen/foundations-of-data-science.md", "# FODS\nKlausur am 02.10.");
write("wiki/personen/emily.md", "# Emily\nprivat");
write("raw/inbox/2026-10-30_daily.md", "Tagesbericht");
// The inbox.
write("LearnHarness/Eingang/Bias-Variance.md", "# Bias und Varianz\nMehr Modellkomplexität senkt den Bias.");
write("LearnHarness/Eingang/FODS/hinweis.txt", "Kapitel 5 ist klausurrelevant.");
write("LearnHarness/Eingang/leer.md", "   \n");
write("LearnHarness/Eingang/.DS_Store", "x");
write("LearnHarness/Eingang/bild.png", "not a document");

const { extraction } = await import("../src/server/chat-handler.ts");
const { scanInbox, startBrainSync, brainStatus, exportToBrain, BRAIN_SYNC_STATE_FILE } = await import("../src/server/brain.ts");
const { brainPromptNote, exportDirFor } = await import("../src/server/brain-folder.ts");
const { ModelsNotConfiguredError } = await import("../src/core/settings.ts");

const imported: string[] = [];
let failWith: Error | null = null;
(extraction as { importNotes: unknown }).importNotes = async (input: { filePath: string; text: string }) => {
	if (failWith) throw failWith;
	imported.push(input.filePath);
	return { nodes: 1, chains: 0 };
};

describe("brain sync", () => {
	it("scans only the inbox, skipping hidden, non-document and imported files", () => {
		assert.deepEqual(scanInbox(BRAIN), ["Bias-Variance.md", "FODS/hinweis.txt", "leer.md"]);
	});

	it("does nothing while no folder is configured", async () => {
		setBrainFolder(null);
		await startBrainSync({ force: true });
		assert.equal(brainStatus().phase, "off");
		assert.deepEqual(imported, []);
		assert.equal(brainPromptNote(), null);
	});

	it("first start: imports the inbox only, moves it to importiert/, exports into wiki/learnharness/", async () => {
		setBrainFolder(BRAIN);
		await startBrainSync({ force: true });
		assert.deepEqual(imported.sort(), [
			"Second Brain/LearnHarness/Eingang/Bias-Variance.md",
			"Second Brain/LearnHarness/Eingang/FODS/hinweis.txt",
		]);
		const status = brainStatus();
		assert.equal(status.phase, "idle", JSON.stringify(status));
		assert.equal(status.exportDir, "wiki/learnharness");
		assert.ok(fs.existsSync(path.join(INBOX, "importiert", "Bias-Variance.md")));
		assert.ok(fs.existsSync(path.join(INBOX, "importiert", "FODS", "hinweis.txt")));
		assert.equal(fs.existsSync(path.join(INBOX, "Bias-Variance.md")), false);
		assert.ok(fs.existsSync(path.join(INBOX, "leer.md")), "an empty file stays where it is");
		assert.deepEqual(fs.readdirSync(EXPORT).sort(), [".learnharness-export.json", "learnharness-stats.json", "lernstand.md"]);
		const stats = JSON.parse(fs.readFileSync(path.join(EXPORT, "learnharness-stats.json"), "utf-8"));
		assert.equal(stats.version, 2);
		assert.equal(stats.totals.sessions, 2);
		assert.ok(fs.existsSync(BRAIN_SYNC_STATE_FILE), "bookkeeping lives in the data dir");
		assert.ok(!fs.existsSync(path.join(BRAIN, "brain-sync.json")), "never in the brain");
	});

	it("later starts import only new documents; a same-named one does not overwrite the old copy", async () => {
		imported.length = 0;
		await startBrainSync({ force: true });
		assert.deepEqual(imported, [], "nothing new");
		write("LearnHarness/Eingang/Bias-Variance.md", "# Bias und Varianz\nZweite Fassung.");
		await startBrainSync({ force: true });
		assert.deepEqual(imported, ["Second Brain/LearnHarness/Eingang/Bias-Variance.md"]);
		assert.ok(fs.existsSync(path.join(INBOX, "importiert", "Bias-Variance (2).md")));
	});

	it("without a force flag it runs only once per app start", async () => {
		imported.length = 0;
		write("LearnHarness/Eingang/Noch-neuer.md", "x");
		await startBrainSync();
		assert.deepEqual(imported, []);
	});

	it("stops with a clear error when models are missing, but still exports", async () => {
		imported.length = 0;
		failWith = new ModelsNotConfiguredError(["strong"] as never);
		fs.rmSync(path.join(EXPORT, "learnharness-stats.json"));
		await startBrainSync({ force: true });
		failWith = null;
		const status = brainStatus();
		assert.equal(status.phase, "error");
		assert.match(status.error ?? "", /Modelle/);
		assert.ok(fs.existsSync(path.join(EXPORT, "learnharness-stats.json")), "export still ran");
		assert.ok(fs.existsSync(path.join(INBOX, "Noch-neuer.md")), "not moved");
		// Not recorded, so the next start tries it again.
		await startBrainSync({ force: true });
		assert.deepEqual(imported, ["Second Brain/LearnHarness/Eingang/Noch-neuer.md"]);
	});

	it("tells the agents where the wiki is", () => {
		const note = brainPromptNote()!;
		assert.ok(note.includes(fs.realpathSync(path.join(BRAIN, "wiki"))));
		assert.match(note, /index\.md/);
		assert.match(note, /Read-only/);
	});

	it("exports into LearnHarness/ when the folder has no wiki/", () => {
		const plain = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brain-plain-"));
		assert.equal(exportDirFor(plain), "LearnHarness");
		exportToBrain(plain);
		assert.ok(fs.existsSync(path.join(plain, "LearnHarness", "lernstand.md")));
	});

	it("never overwrites a file it did not write, and removes only untouched own files", () => {
		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brain-fresh-"));
		const dir = path.join(fresh, "wiki", "learnharness");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "learnharness-stats.json"), "mine");
		const first = exportToBrain(fresh);
		assert.deepEqual(first.conflicts, ["wiki/learnharness/learnharness-stats.json"]);
		assert.equal(fs.readFileSync(path.join(dir, "learnharness-stats.json"), "utf-8"), "mine");

		// Simulate old per-session notes from the first version in the manifest.
		const manifestFile = path.join(dir, ".learnharness-export.json");
		const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
		const stale = "wiki/learnharness/Sessions/alt.md";
		const edited = "wiki/learnharness/Sessions/alt-bearbeitet.md";
		fs.mkdirSync(path.join(dir, "Sessions"));
		fs.writeFileSync(path.join(fresh, stale), "old");
		fs.writeFileSync(path.join(fresh, edited), "edited by the user");
		manifest.files[stale] = crypto.createHash("sha256").update("old").digest("hex");
		manifest.files[edited] = crypto.createHash("sha256").update("original").digest("hex");
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		const second = exportToBrain(fresh);
		assert.equal(second.removed, 1);
		assert.equal(fs.existsSync(path.join(fresh, stale)), false, "untouched stale file removed");
		assert.equal(fs.readFileSync(path.join(fresh, edited), "utf-8"), "edited by the user", "user-edited file kept");
		assert.ok(second.unchanged > 0, "a re-export with no changes rewrites nothing new");
	});

	it("reports a missing folder instead of creating it", async () => {
		setBrainFolder(path.join(BRAIN, "gibt-es-nicht"));
		await startBrainSync({ force: true });
		assert.equal(brainStatus().phase, "error");
		assert.equal(fs.existsSync(path.join(BRAIN, "gibt-es-nicht")), false);
	});
});
