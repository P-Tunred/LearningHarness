/**
 * Second Brain export (fork addition) — the pure half: learning time,
 * session digests, note/stat generation and import-candidate rules.
 * Session data comes from the real golden fixtures (never hand-written).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BRAIN_SOURCE_PREFIX,
	IDLE_GAP_MS,
	brainImportCandidate,
	buildBrainExport,
	digestSession,
	learningTimeByDay,
	localDay,
	safeFileName,
} from "../src/core/brain-export.ts";
import type { ChatRecord } from "../src/core/contracts/chat.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "golden-data");
const goldenChat = (id: string) => JSON.parse(fs.readFileSync(path.join(GOLDEN, "chats", `${id}.json`), "utf-8")) as ChatRecord;
const TEACH = goldenChat("chat_mv27rrra_feff23b6");

const MIN = 60_000;

describe("learningTimeByDay", () => {
	it("sums gaps up to the idle limit and drops longer pauses", () => {
		const t0 = new Date(2026, 9, 31, 9, 0).getTime();
		const byDay = learningTimeByDay([t0, t0 + 2 * MIN, t0 + 5 * MIN, t0 + 5 * MIN + IDLE_GAP_MS + 1, t0 + 20 * MIN]);
		// 2 + 3 counted; the >10-min pause dropped; the last gap (5 min − 1 ms) counted.
		const total = [...byDay.values()].reduce((a, b) => a + b, 0);
		assert.equal(total, 5 * MIN + (20 * MIN - (5 * MIN + IDLE_GAP_MS + 1)));
		assert.deepEqual([...byDay.keys()], [localDay(t0)]);
	});

	it("credits a gap to the day it ends on and ignores junk timestamps", () => {
		const late = new Date(2026, 9, 31, 23, 58).getTime();
		const byDay = learningTimeByDay([late, late + 4 * MIN, Number.NaN, -1]);
		assert.equal(byDay.get(localDay(late + 4 * MIN)), 4 * MIN);
		assert.equal(byDay.has(localDay(late)), false, "the gap ends after midnight");
	});
});

describe("digestSession (golden teach session)", () => {
	const d = digestSession(TEACH);

	it("counts answered questions, grading and unsure items from the answer records", () => {
		assert.equal(d.kind, "teach");
		assert.ok(d.questions > 0, "the fixture answers quiz/probe/recall questions");
		assert.ok(d.graded > 0 && d.correct <= d.graded);
		assert.ok(d.unsure.some((u) => u.reason === "dontKnow"), "the fixture contains a don't-know answer");
		assert.ok(d.unsure.some((u) => u.reason === "incorrect"), "and a wrong one");
		assert.ok(d.learningMs > 0);
	});

	it("never counts ask_user_question as a quiz", () => {
		const asks = TEACH.messages.filter((m) => (m as { details?: { kind?: string } }).details?.kind === "ask").length;
		assert.ok(asks > 0);
		const answered = TEACH.messages.filter((m) => {
			const det = (m as { role?: string; details?: { kind?: string; questionText?: unknown; dismissed?: boolean } });
			return det.role === "toolResult" && typeof det.details?.questionText === "string" && det.details.kind !== "ask" && det.details.dismissed !== true;
		}).length;
		assert.equal(d.questions, answered);
	});
});

describe("safeFileName and import candidates", () => {
	it("strips path and link characters, keeps readable text", () => {
		assert.equal(safeFileName("BKT: p(L|obs) / [update]?"), "BKT p(L obs) update");
		assert.equal(safeFileName("..."), "Unbenannt");
		assert.equal(safeFileName("  "), "Unbenannt");
	});

	it("imports Markdown only, never the export folder or hidden folders", () => {
		assert.equal(brainImportCandidate("Uni/Kostenrechnung.md"), true);
		assert.equal(brainImportCandidate("Notiz.MD"), true);
		assert.equal(brainImportCandidate("LearnHarness/Sessions/x.md"), false);
		assert.equal(brainImportCandidate(".obsidian/workspace.md"), false);
		assert.equal(brainImportCandidate("Uni/.trash/x.md"), false);
		assert.equal(brainImportCandidate("Uni/bild.png"), false);
		assert.equal(brainImportCandidate("Uni/../x.md"), false);
	});
});

describe("buildBrainExport", () => {
	const node = (id: string, name: string, chatId: string, createdAt: string): GraphNode => ({
		id, name, statement: `${name} statement.`, aliases: [], createdAt, provenance: [{ chatId, messageId: "" }],
	});
	const a = node("n_a", "Fixkosten", TEACH.id, "2026-10-10T10:00:00.000Z");
	const b = node("n_b", "Variable Kosten", TEACH.id, "2026-10-10T10:01:00.000Z");
	const c = node("n_c", "Fixkosten", "src_note", "2026-10-10T10:02:00.000Z"); // same name → (2)
	const chain: GraphChain = { id: "arg_1", premises: ["n_a", "n_b"], conclusion: "n_c", provenance: [{ chatId: TEACH.id, messageId: "" }], createdAt: "2026-10-10T10:03:00.000Z" };
	const out = buildBrainExport({
		chats: [TEACH],
		graph: { nodes: [c, b, a], chains: [chain] },
		sources: [{ id: "src_note", filePath: `${BRAIN_SOURCE_PREFIX}Uni/Kosten.md`, importedAt: "2026-10-10T10:00:00.000Z" }],
		now: "2026-10-31T08:00:00.000Z",
	});
	const sessionFile = [...out.files.keys()].find((k) => k.startsWith("LearnHarness/Sessions/"))!;

	it("writes one note per session and per proposition, all under LearnHarness/", () => {
		assert.ok([...out.files.keys()].every((k) => k.startsWith("LearnHarness/")));
		assert.ok(out.files.has("LearnHarness/Aussagen/Fixkosten.md"));
		assert.ok(out.files.has("LearnHarness/Aussagen/Fixkosten (2).md"), "name collisions get a stable suffix");
		assert.ok(out.files.has("LearnHarness/Aussagen/Variable Kosten.md"));
		assert.ok(sessionFile.startsWith(`LearnHarness/Sessions/${TEACH.createdAt.slice(0, 10)} `));
		assert.ok(out.files.has("LearnHarness/learnharness-stats.json"));
	});

	it("links with full paths: chains, sessions and brain notes", () => {
		const conclusion = out.files.get("LearnHarness/Aussagen/Fixkosten (2).md")!;
		assert.match(conclusion, /## Begründet durch\n- \[\[LearnHarness\/Aussagen\/Fixkosten\|Fixkosten\]\] \+ \[\[LearnHarness\/Aussagen\/Variable Kosten\|Variable Kosten\]\] ⇒/);
		assert.match(conclusion, /Notiz: \[\[Uni\/Kosten\]\]/, "a brain-imported source links back to the user's note");
		const premise = out.files.get("LearnHarness/Aussagen/Fixkosten.md")!;
		assert.match(premise, /## Führt zu/);
		assert.match(premise, /Session: \[\[LearnHarness\/Sessions\//);
		const session = out.files.get(sessionFile)!;
		assert.match(session, /## Gelernte Aussagen\n- \[\[LearnHarness\/Aussagen\/Fixkosten\|Fixkosten\]\]/);
		assert.match(session, /## Unsicher oder offen\n- /);
		assert.match(session, /^---\nlearnharness_session: chat_mv27rrra_feff23b6\n/);
	});

	it("produces dashboard stats consistent with the digests", () => {
		const stats = JSON.parse(out.files.get("LearnHarness/learnharness-stats.json")!);
		const d = digestSession(TEACH);
		assert.equal(stats.version, 1);
		assert.equal(stats.generatedAt, "2026-10-31T08:00:00.000Z");
		assert.equal(stats.idleGapMinutes, 10);
		assert.equal(stats.totals.sessions, 1);
		assert.equal(stats.totals.propositions, 3);
		assert.equal(stats.totals.chains, 1);
		assert.equal(stats.totals.questions, d.questions);
		assert.equal(stats.sessions[0].note, sessionFile);
		assert.equal(stats.sessions[0].propositions, 2, "only nodes with this session's provenance");
		const dayMinutes = stats.days.reduce((s: number, day: { learningMinutes: number }) => s + day.learningMinutes, 0);
		assert.ok(Math.abs(dayMinutes - stats.totals.learningMinutes) <= stats.days.length, "per-day rounding only");
	});

	it("is deterministic for the same input", () => {
		const again = buildBrainExport({
			chats: [TEACH],
			graph: { nodes: [a, b, c], chains: [chain] },
			sources: [{ id: "src_note", filePath: `${BRAIN_SOURCE_PREFIX}Uni/Kosten.md`, importedAt: "2026-10-10T10:00:00.000Z" }],
			now: "2026-10-31T08:00:00.000Z",
		});
		assert.deepEqual([...again.files.entries()].sort(), [...out.files.entries()].sort());
	});
});
