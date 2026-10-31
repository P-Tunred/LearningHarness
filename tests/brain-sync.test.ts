/**
 * Second Brain sync (fork addition) — the IO half against real files: a
 * temp copy of the golden data dir (LH_DATA_DIR seam, set before any store
 * import) and a temp brain folder. The notes-import pipeline is replaced by
 * a recorder, so no model is called.
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

function writeNote(rel: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(BRAIN, rel)), { recursive: true });
	fs.writeFileSync(path.join(BRAIN, rel), text);
}
function setBrainFolder(folder: string | null) {
	const file = path.join(DATA, "settings.json");
	const record = JSON.parse(fs.readFileSync(file, "utf-8"));
	record.brain = folder === null ? {} : { folder };
	fs.writeFileSync(file, JSON.stringify(record));
}

writeNote("Uni/Kostenrechnung.md", "# Kostenrechnung\nFixkosten fallen unabhängig von der Menge an.");
writeNote("Tagebuch.md", "Heute gelernt.");
writeNote("leer.md", "   \n");
writeNote(".obsidian/workspace.md", "hidden");
writeNote("LearnHarness/eigene-alte-notiz.md", "inside the export folder: never imported");
writeNote("Uni/bild.png", "not markdown");

const { extraction } = await import("../src/server/chat-handler.ts");
const { scanBrain, startBrainSync, brainStatus, exportToBrain, BRAIN_SYNC_STATE_FILE } = await import("../src/server/brain.ts");
const { ModelsNotConfiguredError } = await import("../src/core/settings.ts");

const imported: string[] = [];
let failWith: Error | null = null;
(extraction as { importNotes: unknown }).importNotes = async (input: { filePath: string; text: string }) => {
	if (failWith) throw failWith;
	imported.push(input.filePath);
	return { nodes: 1, chains: 0 };
};

describe("brain sync", () => {
	it("scans Markdown notes outside the export folder and hidden folders", () => {
		assert.deepEqual(scanBrain(BRAIN), ["Tagebuch.md", "Uni/Kostenrechnung.md", "leer.md"]);
	});

	it("does nothing while no folder is configured", async () => {
		setBrainFolder(null);
		await startBrainSync({ force: true });
		assert.equal(brainStatus().phase, "off");
		assert.deepEqual(imported, []);
	});

	it("first start: imports every non-empty note, then exports into LearnHarness/", async () => {
		setBrainFolder(BRAIN);
		await startBrainSync({ force: true });
		assert.deepEqual(imported.sort(), ["Second Brain/Tagebuch.md", "Second Brain/Uni/Kostenrechnung.md"]);
		const status = brainStatus();
		assert.equal(status.phase, "idle", JSON.stringify(status));
		assert.equal(status.import?.total, 2);
		const sessions = fs.readdirSync(path.join(BRAIN, "LearnHarness", "Sessions"));
		assert.equal(sessions.length, 2, "one note per golden session");
		assert.ok(fs.readdirSync(path.join(BRAIN, "LearnHarness", "Aussagen")).length > 0, "golden graph propositions exported");
		const stats = JSON.parse(fs.readFileSync(path.join(BRAIN, "LearnHarness", "learnharness-stats.json"), "utf-8"));
		assert.equal(stats.totals.sessions, 2);
		assert.ok(fs.existsSync(path.join(BRAIN, "LearnHarness", ".learnharness-export.json")));
		assert.equal(fs.readFileSync(path.join(BRAIN, "LearnHarness", "eigene-alte-notiz.md"), "utf-8"), "inside the export folder: never imported");
		assert.ok(fs.existsSync(BRAIN_SYNC_STATE_FILE), "bookkeeping lives in the data dir");
		assert.ok(!fs.existsSync(path.join(BRAIN, "brain-sync.json")), "never in the brain");
	});

	it("later starts import only new or changed notes", async () => {
		imported.length = 0;
		await startBrainSync({ force: true });
		assert.deepEqual(imported, [], "nothing changed");
		writeNote("Uni/Kostenrechnung.md", "# Kostenrechnung\nGeändert: auch variable Kosten.");
		writeNote("Neu.md", "Neue Notiz");
		await startBrainSync({ force: true });
		assert.deepEqual(imported.sort(), ["Second Brain/Neu.md", "Second Brain/Uni/Kostenrechnung.md"]);
	});

	it("without a force flag it runs only once per app start", async () => {
		imported.length = 0;
		writeNote("Noch-neuer.md", "x");
		await startBrainSync();
		assert.deepEqual(imported, []);
	});

	it("stops with a clear error when models are missing, but still exports", async () => {
		imported.length = 0;
		failWith = new ModelsNotConfiguredError(["strong"] as never);
		fs.rmSync(path.join(BRAIN, "LearnHarness", "learnharness-stats.json"));
		await startBrainSync({ force: true });
		failWith = null;
		const status = brainStatus();
		assert.equal(status.phase, "error");
		assert.match(status.error ?? "", /Modelle/);
		assert.ok(fs.existsSync(path.join(BRAIN, "LearnHarness", "learnharness-stats.json")), "export still ran");
		// The note was not recorded, so the next start tries it again.
		await startBrainSync({ force: true });
		assert.deepEqual(imported, ["Second Brain/Noch-neuer.md"]);
	});

	it("never overwrites a file it did not write, and removes only untouched own files", () => {
		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "lh-brain-fresh-"));
		fs.mkdirSync(path.join(fresh, "LearnHarness"), { recursive: true });
		fs.writeFileSync(path.join(fresh, "LearnHarness", "learnharness-stats.json"), "mine");
		const first = exportToBrain(fresh);
		assert.deepEqual(first.conflicts, ["LearnHarness/learnharness-stats.json"]);
		assert.equal(fs.readFileSync(path.join(fresh, "LearnHarness", "learnharness-stats.json"), "utf-8"), "mine");

		// Simulate a stale own file (e.g. a renamed session) in the manifest.
		const manifestFile = path.join(fresh, "LearnHarness", ".learnharness-export.json");
		const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
		const stale = "LearnHarness/Sessions/alt.md";
		const edited = "LearnHarness/Sessions/alt-bearbeitet.md";
		fs.writeFileSync(path.join(fresh, stale), "old");
		fs.writeFileSync(path.join(fresh, edited), "edited by the user");
		manifest.files[stale] = crypto.createHash("sha256").update("old").digest("hex");
		manifest.files[edited] = crypto.createHash("sha256").update("original").digest("hex");
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		const second = exportToBrain(fresh);
		assert.equal(second.removed, 1);
		assert.equal(fs.existsSync(path.join(fresh, stale)), false, "untouched stale file removed");
		assert.equal(fs.readFileSync(path.join(fresh, edited), "utf-8"), "edited by the user", "user-edited file kept");
		assert.ok(second.unchanged > 0 && second.written === 0, "a re-export with no changes rewrites nothing");
	});

	it("reports a missing folder instead of creating it", async () => {
		setBrainFolder(path.join(BRAIN, "gibt-es-nicht"));
		await startBrainSync({ force: true });
		assert.equal(brainStatus().phase, "error");
		assert.equal(fs.existsSync(path.join(BRAIN, "gibt-es-nicht")), false);
	});
});
