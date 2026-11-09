"use client";

/**
 * XP float (fork addition, Paul 2026-11-09): when an answer moves the
 * numbers of the exam topic you are in, small "+4 %  understood" /
 * "+10 %  worked through" pop up to the left of the chat, drift up and
 * fade — green for a gain, red for a drop. Same numbers as the notch and
 * the overview (GET /api/exam-progress, refreshed after every turn);
 * "understood" only once it is measurable (3 graded answers). Opening
 * another chat resets the baseline, so nothing pops on navigation.
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface XpTopic {
	chatId: string;
	progress: number;
	understanding: number | null;
}

export interface XpGain {
	label: "understood" | "worked through";
	/** Percentage points, rounded; never 0. */
	points: number;
}

/** What changed between two readings of the same topic. Exported for tests. */
export function xpGains(before: XpTopic, after: XpTopic): XpGain[] {
	if (before.chatId !== after.chatId) return [];
	const out: XpGain[] = [];
	if (before.understanding !== null && after.understanding !== null) {
		const points = Math.round((after.understanding - before.understanding) * 100);
		if (points !== 0) out.push({ label: "understood", points });
	}
	const points = Math.round((after.progress - before.progress) * 100);
	if (points !== 0) out.push({ label: "worked through", points });
	return out;
}

interface Floater extends XpGain {
	id: number;
	/** Offsets from the anchor, so each pop lands a little elsewhere. */
	right: number;
	bottom: number;
	delay: number;
}

const LIFE_MS = 2600;
const STAGGER_MS = 280;

export function XpFloat({ topic }: { topic: XpTopic | null }) {
	const last = useRef<XpTopic | null>(null);
	const nextId = useRef(0);
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	const [floaters, setFloaters] = useState<Floater[]>([]);

	// Removal timers outlive later readings; only unmount clears them.
	useEffect(() => {
		const all = timers.current;
		return () => {
			for (const t of all) clearTimeout(t);
		};
	}, []);

	// Keyed by the values, not the object: every refresh builds a new one.
	const chatId = topic?.chatId ?? null;
	const progress = topic?.progress ?? null;
	const understanding = topic?.understanding ?? null;
	useEffect(() => {
		const now = chatId !== null && progress !== null ? { chatId, progress, understanding } : null;
		const before = last.current;
		last.current = now;
		if (!before || !now) return;
		const gains = xpGains(before, now);
		if (gains.length === 0) return;
		// Left of the chat column (Paul, 2026-11-09), at the height of the
		// answer box: measured now, since the sidebar may be open or closed.
		const dock = document.querySelector("[data-dock-viewport]")?.getBoundingClientRect();
		const edge = dock ? window.innerWidth - dock.left : window.innerWidth - 320;
		const floor = dock ? window.innerHeight - dock.bottom : 96;
		const born = gains.map((g, i) => ({
			...g,
			id: nextId.current++,
			right: edge + 14 + Math.random() * 26,
			bottom: floor + 24 + i * 46 + Math.random() * 36,
			delay: i * STAGGER_MS,
		}));
		setFloaters((all) => [...all, ...born]);
		const ids = new Set(born.map((f) => f.id));
		const t = setTimeout(() => {
			timers.current.delete(t);
			setFloaters((all) => all.filter((f) => !ids.has(f.id)));
		}, LIFE_MS + STAGGER_MS * born.length);
		timers.current.add(t);
	}, [chatId, progress, understanding]);

	if (floaters.length === 0) return null;
	return (
		<div aria-live="polite" className="pointer-events-none fixed inset-0 z-30" data-testid="xp-float">
			{floaters.map((f) => (
				<span
					key={f.id}
					className={cn(
						"lh-xp-rise absolute flex flex-col items-end leading-none drop-shadow-[0_1px_6px_rgb(0_0_0/0.45)]",
						f.points > 0 ? "text-green-400" : "text-red-400",
					)}
					style={{ right: f.right, bottom: f.bottom, animationDelay: `${f.delay}ms` }}
				>
					<span className="text-sm font-semibold tabular-nums">
						{f.points > 0 ? "+" : "−"}
						{Math.abs(f.points)} %
					</span>
					<span className="mt-0.5 text-[10px] uppercase tracking-wider opacity-80">{f.label}</span>
				</span>
			))}
		</div>
	);
}
