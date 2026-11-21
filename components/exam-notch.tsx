"use client";

/**
 * Exam progress notch (fork addition) — top centre of the window, like a
 * notch hanging from the top edge. Closed: the nearest exam · where Paul
 * stands · what is left today, over a thin progress bar. A click folds it
 * open: one card per exam (line bar, done/understood, today, up next with
 * links into the sessions) and "Details" to the overview page (/exams).
 * In a topic chat of an exam plan the closed notch speaks for THAT exam and
 * adds the topic's own Done bar under the total — on hover its two parts,
 * worked through and understood. Chats start their top bar below the
 * resting notch (NOTCH_HEIGHT_VAR, TopBar clearNotch), so it never covers
 * the title.
 * Escape or a click outside folds it back; the open/closed choice is
 * remembered on this device. Hidden while no exam plan runs.
 * Subject switcher (Paul, 2026-11-11): with more than one exam, the open
 * notch starts with All · one button per exam. The chosen exam is what the
 * closed notch speaks for (outside a topic chat) and what the home graph
 * shows (components/chosen-exam.ts); All = nearest exam, whole graph.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDownIcon, MaximizeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Active, ExamBlock, hm, pct, STANDING, standingLabel, useExamProgress } from "@/components/exam-progress";
import { XpFloat } from "@/components/xp-float";
import { chosenAmong, useChosenExam } from "@/components/chosen-exam";
import { ExamSwitcher } from "@/components/exam-switcher";
import { UNDERSTANDING_TARGET } from "@/src/core";

const OPEN_KEY = "lh.examNotch.open";

function useRememberedOpen(): [boolean, (next: boolean) => void] {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		try {
			if (window.localStorage.getItem(OPEN_KEY) === "1") setOpen(true);
		} catch {
			/* storage unavailable: starts closed */
		}
	}, []);
	const set = useCallback((next: boolean) => {
		setOpen(next);
		try {
			window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
		} catch {
			/* storage unavailable: this window only */
		}
	}, []);
	return [open, set];
}

/** The exam the closed notch speaks for: the nearest one. Exported for tests. */
export function nearestExam<T extends Pick<Active, "daysToExam">>(exams: readonly T[]): T | undefined {
	return [...exams].sort((a, b) => a.daysToExam - b.daysToExam)[0];
}

/** The exam plan topic a chat belongs to, with its exam (Paul, 2026-11-09:
 *  in a topic chat the notch speaks for that chat's exam and shows the
 *  topic under the total). Exported for tests. */
export function topicOfChat<T extends { focuses: ReadonlyArray<{ chatId?: string }> }>(
	exams: readonly T[],
	chatId: string | null,
): { exam: T; focus: T["focuses"][number] } | undefined {
	if (!chatId) return undefined;
	for (const exam of exams) {
		const focus = exam.focuses.find((f) => f.chatId === chatId);
		if (focus) return { exam, focus };
	}
	return undefined;
}

/** CSS variable with the closed notch's resting height (TopBar clearNotch). */
export const NOTCH_HEIGHT_VAR = "--lh-notch-h";

function TopicBar({ value, className, label }: { value: number; className: string; label: string }) {
	return (
		<span className="relative block h-1 w-full rounded-full bg-border" role="img" aria-label={label}>
			<span
				className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", className)}
				style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
			/>
		</span>
	);
}

const chatIdFrom = (pathname: string | null) => /^\/chat\/([^/]+)$/.exec(pathname ?? "")?.[1] ?? null;

/** "25 min to go" / "done ✓" for the closed notch. Exported for tests. */
export function todayLine(p: Pick<Active, "leftToday" | "targetToday">): string {
	if (p.targetToday > 0 && p.leftToday === 0) return "today done ✓";
	return `${hm(p.leftToday)} to go`;
}

export function ExamNotch() {
	const { exams } = useExamProgress();
	const pathname = usePathname();
	const [open, setOpen] = useRememberedOpen();
	const ref = useRef<HTMLDivElement>(null);
	const toggleRef = useRef<HTMLButtonElement>(null);
	// Hover shows the topic's two bars (Paul, 2026-11-09).
	const [hover, setHover] = useState(false);
	const hoverRef = useRef(false);
	const [chosenName, choose] = useChosenExam();
	const chosen = chosenAmong(exams, chosenName);
	const topic = topicOfChat(exams, chatIdFrom(pathname));
	const p = topic?.exam ?? chosen ?? nearestExam(exams);
	const shown = !!p;

	// The resting height of the closed notch, for the chat's top bar to
	// start below it (TopBar clearNotch). Measured on the toggle row — the
	// folded-open panel hangs below it — and never while hovering, so the
	// two hover bars do not make the chat jump.
	useEffect(() => {
		const root = document.documentElement;
		const el = toggleRef.current;
		if (!shown || !el) return;
		const measure = () => {
			if (!hoverRef.current) root.style.setProperty(NOTCH_HEIGHT_VAR, `${Math.ceil(el.getBoundingClientRect().height)}px`);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty(NOTCH_HEIGHT_VAR);
		};
	}, [shown]);
	const setHovering = (on: boolean) => {
		hoverRef.current = on;
		setHover(on);
	};

	// Escape and outside clicks fold it back. Escape is claimed at the
	// document (the one-Esc law, as the settings dialog does) so it does not
	// also reach the window-level shortcuts.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		};
		const onDown = (e: PointerEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDown);
		};
	}, [open, setOpen]);

	if (!p) return null;
	const s = STANDING[p.standing];
	const more = exams.length - 1;
	const narrowHidden = open ? undefined : "max-[1899px]:hidden";

	return (
		<>
		{/* Outside the notch: its transform would trap a fixed child. */}
		<XpFloat topic={topic ? { chatId: topic.focus.chatId!, progress: topic.focus.progress, understanding: topic.focus.understanding } : null} />
		<div
			ref={ref}
			data-testid="exam-notch"
			onMouseEnter={() => setHovering(true)}
			onMouseLeave={() => setHovering(false)}
			className={cn(
				"lh-no-drag fixed left-1/2 top-0 z-40 -translate-x-1/2 overflow-hidden rounded-b-2xl border border-t-0 border-border bg-card/95 shadow-lg backdrop-blur transition-[width] duration-200",
				open ? "w-[min(26rem,calc(100vw-1.5rem))]" : "w-max max-w-[calc(100vw-10rem)]",
			)}
		>
			<button
				ref={toggleRef}
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				aria-controls="exam-notch-panel"
				data-testid="exam-notch-toggle"
				className="flex w-full flex-col gap-1.5 px-4 pb-2 pt-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
			>
				<span className="flex w-full min-w-0 items-baseline gap-2 whitespace-nowrap text-xs tabular-nums">
					<span className="min-w-0 truncate font-medium text-foreground">{p.exam}</span>
					{/* Narrow window (< 1900px), notch closed: subject, bar and +N
					    only, so the graph's search magnifier beside it stays free
					    (fork, Paul 2026-11-21); opening shows the full line. */}
					<span className={cn("shrink-0 text-muted-foreground/60", narrowHidden)}>·</span>
					<span className={cn("shrink-0 font-medium", s.tone, narrowHidden)}>{standingLabel(p)}</span>
					<span className={cn("shrink-0 text-muted-foreground/60", narrowHidden)}>·</span>
					<span className={cn("shrink-0 text-muted-foreground", narrowHidden)}>{todayLine(p)}</span>
					{more > 0 && <span className="shrink-0 text-muted-foreground/70">+{more}</span>}
					<ChevronDownIcon className={cn("size-3 shrink-0 self-center text-muted-foreground transition-transform", open && "rotate-180")} />
				</span>
				<span className="relative block h-1 w-full rounded-full bg-border" aria-hidden="true">
					<span
						className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500", s.fill)}
						style={{ width: `${Math.round(Math.min(1, Math.max(0, p.ist)) * 100)}%` }}
					/>
				</span>
				{topic && (
					// This chat's topic: Done = worked through × understood, the
					// same measure as the total; on hover its two parts instead.
					// `w-0 min-w-full` keeps a long title from widening the notch.
					<span className="flex w-0 min-w-full flex-col gap-1 pt-0.5" data-testid="exam-notch-topic">
						<span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
							<span className="min-w-0 truncate">{topic.focus.title}</span>
							{!hover && <span className="ml-auto shrink-0 text-foreground">{pct(topic.focus.done)}</span>}
						</span>
						{hover ? (
							<span className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-[11px] tabular-nums text-muted-foreground" data-testid="exam-notch-topic-detail">
								<span>worked through</span>
								<TopicBar value={topic.focus.progress} className="bg-foreground/70" label={`${pct(topic.focus.progress)} worked through`} />
								<span className="text-right text-foreground">{pct(topic.focus.progress)}</span>
								<span>understood</span>
								{topic.focus.understanding === null ? (
									<span className="col-span-2 text-muted-foreground/70">not enough answers yet</span>
								) : (
									<>
										<TopicBar
											value={topic.focus.understanding}
											className={topic.focus.understanding < UNDERSTANDING_TARGET ? "bg-amber-500" : "bg-green-500"}
											label={`${pct(topic.focus.understanding)} understood`}
										/>
										<span className={cn("text-right", topic.focus.understanding < UNDERSTANDING_TARGET ? "text-amber-500" : "text-foreground")}>
											{pct(topic.focus.understanding)}
										</span>
									</>
								)}
							</span>
						) : (
							<TopicBar value={topic.focus.done} className="bg-foreground/70" label={`This topic: ${pct(topic.focus.done)} done`} />
						)}
					</span>
				)}
			</button>

			{open && (
				<div id="exam-notch-panel" className="flex max-h-[70dvh] flex-col gap-2 overflow-y-auto border-t border-border/60 px-3 pb-3 pt-2">
					<ExamSwitcher exams={exams} chosen={chosen?.exam ?? null} onChoose={choose} />
					{[...exams]
						.sort((a, b) => a.daysToExam - b.daysToExam)
						.map((e) => (
							<ExamBlock key={`${e.exam}|${e.date}`} p={e} />
						))}
					<Link
						href="/exams"
						onClick={() => setOpen(false)}
						data-testid="exam-notch-details"
						className="flex items-center justify-center gap-1.5 rounded-md py-1 text-xs uppercase tracking-widest text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						Details <MaximizeIcon className="size-3" />
					</Link>
				</div>
			)}
		</div>
		</>
	);
}
