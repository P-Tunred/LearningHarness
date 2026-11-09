"use client";

/**
 * Exam progress notch (fork addition) — top centre of the window, like a
 * notch hanging from the top edge. Closed: the nearest exam · where Paul
 * stands · what is left today, over a thin progress bar. A click folds it
 * open: one card per exam (line bar, done/understood, today, up next with
 * links into the sessions) and "Details" to the overview page (/exams).
 * In a topic chat of an exam plan the closed notch speaks for THAT exam and
 * adds the topic's own Done bar under the total.
 * Escape or a click outside folds it back; the open/closed choice is
 * remembered on this device. Hidden while no exam plan runs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDownIcon, MaximizeIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Active, ExamBlock, hm, pct, STANDING, standingLabel, useExamProgress } from "@/components/exam-progress";

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

	const topic = topicOfChat(exams, chatIdFrom(pathname));
	const p = topic?.exam ?? nearestExam(exams);
	if (!p) return null;
	const s = STANDING[p.standing];
	const more = exams.length - 1;

	return (
		<div
			ref={ref}
			data-testid="exam-notch"
			className={cn(
				"lh-no-drag fixed left-1/2 top-0 z-40 -translate-x-1/2 overflow-hidden rounded-b-2xl border border-t-0 border-border bg-card/95 shadow-lg backdrop-blur transition-[width] duration-200",
				open ? "w-[min(26rem,calc(100vw-1.5rem))]" : "w-max max-w-[calc(100vw-10rem)]",
			)}
		>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				aria-controls="exam-notch-panel"
				data-testid="exam-notch-toggle"
				className="flex w-full flex-col gap-1.5 px-4 pb-2 pt-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
			>
				<span className="flex w-full min-w-0 items-baseline gap-2 whitespace-nowrap text-xs tabular-nums">
					<span className="min-w-0 truncate font-medium text-foreground">{p.exam}</span>
					<span className="shrink-0 text-muted-foreground/60">·</span>
					<span className={cn("shrink-0 font-medium", s.tone)}>{standingLabel(p)}</span>
					<span className="shrink-0 text-muted-foreground/60">·</span>
					<span className="shrink-0 text-muted-foreground">{todayLine(p)}</span>
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
					// same measure as the total. `w-0 min-w-full` keeps a long
					// title from widening the notch.
					<span className="flex w-0 min-w-full flex-col gap-1 pt-0.5" data-testid="exam-notch-topic">
						<span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
							<span className="min-w-0 truncate">{topic.focus.title}</span>
							<span className="ml-auto shrink-0 text-foreground">{pct(topic.focus.done)}</span>
						</span>
						<span className="relative block h-1 w-full rounded-full bg-border" role="img" aria-label={`This topic: ${pct(topic.focus.done)} done`}>
							<span
								className="absolute inset-y-0 left-0 rounded-full bg-foreground/70 transition-[width] duration-500"
								style={{ width: `${Math.round(Math.min(1, Math.max(0, topic.focus.done)) * 100)}%` }}
							/>
						</span>
					</span>
				)}
			</button>

			{open && (
				<div id="exam-notch-panel" className="flex max-h-[70dvh] flex-col gap-2 overflow-y-auto border-t border-border/60 px-3 pb-3 pt-2">
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
	);
}
