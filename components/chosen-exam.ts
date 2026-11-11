"use client";

/**
 * The subject switcher (fork addition, Paul 2026-11-11): "switch Fächer at
 * the top so you see the knowledge graph". The exam notch picks one exam
 * plan — or All — and the home graph shows only what was learned in that
 * exam's topic sessions. The choice is remembered on this device and
 * announced to every surface in the window (LH_EXAM_CHOSEN), so the notch
 * and the graph never disagree.
 *
 * null = All: the notch speaks for the nearest exam, the graph shows
 * everything — exactly the behaviour before the switcher existed.
 */

import { useCallback, useEffect, useState } from "react";
import type { GraphChain, GraphNode } from "@/src/core";

const CHOSEN_KEY = "lh.examNotch.chosen";
export const LH_EXAM_CHOSEN = "lh:exam-chosen";

function readChosen(): string | null {
	try {
		return window.localStorage.getItem(CHOSEN_KEY) || null;
	} catch {
		return null;
	}
}

export function useChosenExam(): [string | null, (exam: string | null) => void] {
	const [chosen, setChosen] = useState<string | null>(null);
	useEffect(() => {
		setChosen(readChosen());
		const onChosen = () => setChosen(readChosen());
		window.addEventListener(LH_EXAM_CHOSEN, onChosen);
		window.addEventListener("storage", onChosen);
		return () => {
			window.removeEventListener(LH_EXAM_CHOSEN, onChosen);
			window.removeEventListener("storage", onChosen);
		};
	}, []);
	const choose = useCallback((exam: string | null) => {
		try {
			if (exam) window.localStorage.setItem(CHOSEN_KEY, exam);
			else window.localStorage.removeItem(CHOSEN_KEY);
		} catch {
			/* storage unavailable: this window only */
		}
		setChosen(exam);
		window.dispatchEvent(new Event(LH_EXAM_CHOSEN));
	}, []);
	return [chosen, choose];
}

/** The chosen exam among the running ones; a remembered name whose plan is
 *  gone (exam over, file removed) counts as All. Exported for tests. */
export function chosenAmong<T extends { exam: string }>(exams: readonly T[], chosen: string | null): T | undefined {
	return chosen ? exams.find((e) => e.exam === chosen) : undefined;
}

/** The chats that belong to an exam: its topic sessions. */
export function examChatIds(exam: { focuses: ReadonlyArray<{ chatId?: string }> }): Set<string> {
	return new Set(exam.focuses.flatMap((f) => (f.chatId ? [f.chatId] : [])));
}

/** The chats in the exam plan's order (the learning path); chats outside
 *  the plan (the open one) keep their place behind it. Exported for tests. */
export function inPlanOrder<T extends { id: string }>(chats: readonly T[], exam: { focuses: ReadonlyArray<{ chatId?: string }> }): T[] {
	const rank = new Map(exam.focuses.flatMap((f, i) => (f.chatId ? [[f.chatId, i] as const] : [])));
	return chats
		.map((c, i) => ({ c, r: rank.get(c.id) ?? exam.focuses.length + i }))
		.sort((a, b) => a.r - b.r)
		.map((x) => x.c);
}

/** Which canvas nodes belong to these chats: every proposition asserted in
 *  one of them, and every implication node (id = chain id) whose premises
 *  and conclusion all stay — an arrow into a hidden node would point at
 *  nothing. Imported notes carry no chat and stay out. Exported for tests. */
export function subjectNodeIds(
	snapshot: { propositions: ReadonlyArray<Pick<GraphNode, "id" | "provenance">>; chains: ReadonlyArray<Pick<GraphChain, "id" | "premises" | "conclusion">> },
	chats: ReadonlySet<string>,
): Set<string> {
	const keep = new Set<string>();
	for (const n of snapshot.propositions) {
		if (n.provenance.some((p) => chats.has(p.chatId))) keep.add(n.id);
	}
	for (const c of snapshot.chains) {
		if (keep.has(c.conclusion) && c.premises.every((id) => keep.has(id))) keep.add(c.id);
	}
	return keep;
}
