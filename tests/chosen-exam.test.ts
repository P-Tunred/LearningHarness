/**
 * Subject switcher (fork addition, 2026-11-11): which exam is chosen, and
 * which graph nodes belong to its topic sessions.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chosenAmong, examChatIds, inPlanOrder, subjectNodeIds } from "../components/chosen-exam.ts";

const at = (chatId: string) => ({ chatId, messageId: "m" });

describe("subject switcher", () => {
	it("a remembered exam that no longer runs counts as All", () => {
		const exams = [{ exam: "FODS Theorie" }, { exam: "INTSEC" }];
		assert.equal(chosenAmong(exams, "INTSEC")?.exam, "INTSEC");
		assert.equal(chosenAmong(exams, "KM"), undefined);
		assert.equal(chosenAmong(exams, null), undefined);
	});

	it("lists an exam's chats in the plan's order, the open outside chat behind them", () => {
		const exam = { focuses: [{ chatId: "c3" }, { chatId: "c1" }, {}, { chatId: "c2" }] };
		const chats = [{ id: "c1" }, { id: "open" }, { id: "c2" }, { id: "c3" }];
		assert.deepEqual(inPlanOrder(chats, exam).map((c) => c.id), ["c3", "c1", "c2", "open"]);
	});

	it("an exam's chats are its topic sessions", () => {
		assert.deepEqual([...examChatIds({ focuses: [{ chatId: "c1" }, {}, { chatId: "c2" }] })], ["c1", "c2"]);
	});

	it("keeps the propositions of those chats and only arrows between kept nodes", () => {
		const snapshot = {
			propositions: [
				{ id: "n1", provenance: [at("c1")] },
				{ id: "n2", provenance: [at("other"), at("c1")] },
				{ id: "n3", provenance: [at("other")] },
				{ id: "n4", provenance: [at("src_notes")] },
			],
			chains: [
				{ id: "arg_in", premises: ["n1"], conclusion: "n2" },
				{ id: "arg_out", premises: ["n1", "n3"], conclusion: "n2" },
			],
		};
		assert.deepEqual([...subjectNodeIds(snapshot, new Set(["c1"]))].sort(), ["arg_in", "n1", "n2"]);
		assert.equal(subjectNodeIds(snapshot, new Set()).size, 0);
	});
});
