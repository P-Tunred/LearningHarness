/**
 * XP float (fork addition, Paul 2026-11-09): which "+x %" pops appear when
 * the numbers of the topic you are in change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { xpGains, xpText } from "../components/xp-float.tsx";

describe("xpGains", () => {
	const t = (progress: number, understanding: number | null, chatId = "c1") => ({ chatId, progress, understanding });

	it("reports gains and drops in whole percentage points", () => {
		assert.deepEqual(xpGains(t(0.5, 0.7), t(0.6, 0.74)), [
			{ label: "understood", points: 4 },
			{ label: "worked through", points: 10 },
		]);
		assert.deepEqual(xpGains(t(0.6, 0.74), t(0.6, 0.71)), [{ label: "understood", points: -3 }]);
	});

	it("stays quiet without a change, across chats, or while understanding is not measurable", () => {
		assert.deepEqual(xpGains(t(0.6, 0.7), t(0.6, 0.7)), []);
		assert.deepEqual(xpGains(t(0.2, 0.5, "a"), t(0.9, 0.9, "b")), [], "opening another chat is not a gain");
		assert.deepEqual(xpGains(t(0.5, null), t(0.5, 0.67)), [], "first measurable understanding is no gain");
		assert.deepEqual(xpGains(t(0.5, 0.7), t(0.5004, 0.7003)), [], "below a twentieth of a point rounds away");
	});

	it("shows changes below 1 % with one decimal", () => {
		assert.deepEqual(xpGains(t(0.5, 0.7), t(0.504, 0.7031)), [
			{ label: "understood", points: 0.3 },
			{ label: "worked through", points: 0.4 },
		]);
		assert.equal(xpText(0.4), "+0.4 %");
		assert.equal(xpText(-0.3), "−0.3 %");
		assert.equal(xpText(4), "+4 %");
		assert.equal(xpText(-12.6), "−13 %");
	});
});
