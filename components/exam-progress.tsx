"use client";

/**
 * Exam progress strip (fork addition) — bottom of the sidebar, one quiet
 * block per exam plan from the brain: am I ahead of or behind the line,
 * how well does it stick, and how much is left today. A click unfolds
 * what is up next and how the target is computed.
 *
 * English on purpose (Paul, 2026-10-31): the exams are in English, so is
 * everything that plans for them. The numbers come from
 * src/core/exam-progress.ts via GET /api/exam-progress; learning time is
 * what the exam sessions themselves measured (message times, pauses over
 * 10 min do not count) — no timer to start.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { UNDERSTANDING_TARGET, type ExamProgress as ExamProgressData, type Standing } from "@/src/core";

type Active = Extract<ExamProgressData, { phase: "study" | "revision" }>;

/** Day rollover and drift: refetch at least this often. */
const REFRESH_MS = 5 * 60 * 1000;
/** Turns settle in bursts; one fetch per burst. */
const EVENT_DEBOUNCE_MS = 1500;

const STANDING: Record<Standing, { tone: string; fill: string }> = {
	ahead: { tone: "text-green-500", fill: "bg-green-500" },
	"on-track": { tone: "text-green-500", fill: "bg-green-500" },
	behind: { tone: "text-amber-500", fill: "bg-amber-500" },
	"far-behind": { tone: "text-red-400", fill: "bg-red-400" },
};

function hm(min: number): string {
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

const pct = (share: number) => `${Math.round(share * 100)} %`;

function standingLabel(p: Active): string {
	const h = Math.abs(p.deltaHours).toFixed(1).replace(/\.0$/, "");
	if (p.standing === "on-track") return "on track";
	return p.deltaHours > 0 ? `${h} h ahead` : `${h} h behind`;
}

function useExamProgress(): Active[] {
	const [data, setData] = useState<Active[]>([]);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/exam-progress", { cache: "no-store" });
			if (!res.ok) return; // keep the last good numbers; the route logs why
			const all = (await res.json()) as ExamProgressData[];
			setData(all.filter((p): p is Active => p.phase === "study" || p.phase === "revision"));
		} catch {
			/* offline dev server: keep the last good numbers */
		}
	}, []);
	const schedule = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => void load(), EVENT_DEBOUNCE_MS);
	}, [load]);
	useEffect(() => {
		void load();
		const every = setInterval(() => void load(), REFRESH_MS);
		return () => {
			clearInterval(every);
			if (timer.current) clearTimeout(timer.current);
		};
	}, [load]);
	useServerEvent("turn-settled", schedule);
	useServerEvent("chats-changed", schedule);
	useServerResync(schedule);
	return data;
}

function LineBar({ p }: { p: Active }) {
	const s = STANDING[p.standing];
	return (
		<div
			className="relative h-1 w-full rounded-full bg-border"
			role="img"
			aria-label={`${pct(p.ist)} of the plan done, ${pct(p.soll)} expected by today`}
		>
			<div
				className={cn("absolute inset-y-0 left-0 w-full origin-left rounded-full transition-transform duration-500", s.fill)}
				style={{ transform: `scaleX(${Math.min(1, Math.max(0, p.ist))})` }}
			/>
			{/* The line: where he should be this morning. */}
			<div
				className="absolute -top-1 h-3 w-px bg-foreground/70"
				style={{ left: `${Math.min(100, p.soll * 100)}%` }}
				aria-hidden="true"
			/>
		</div>
	);
}

function ExamBlock({ p }: { p: Active }) {
	const [open, setOpen] = useState(false);
	const router = useRouter();
	const s = STANDING[p.standing];
	const todayDone = p.leftToday === 0 && p.targetToday > 0;
	return (
		<div className="flex flex-col gap-1.5" data-testid="exam-progress">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="flex flex-col gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				<span className="flex items-baseline gap-2 text-xs">
					<span className="truncate font-medium text-foreground">{p.exam}</span>
					<span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
						{p.phase === "revision" ? "revision · " : ""}
						{p.daysToExam} d
					</span>
				</span>
				<LineBar p={p} />
				<span className="flex items-baseline gap-1.5 text-[11px] tabular-nums">
					<span className={cn("font-medium", s.tone)}>{standingLabel(p)}</span>
					<span className="ml-auto text-muted-foreground" title={`Target ${pct(UNDERSTANDING_TARGET)} right answers`}>
						done {pct(p.ist)} · understood {p.understanding === null ? "—" : pct(p.understanding)}
					</span>
				</span>
				<span className="text-[11px] tabular-nums text-muted-foreground">
					{todayDone ? (
						<span className="text-foreground">Today {hm(p.minutesToday)} · done ✓</span>
					) : (
						<>
							Today <span className="text-foreground">{hm(p.minutesToday)}</span> of {hm(p.targetToday)} · {hm(p.leftToday)} to go
						</>
					)}
				</span>
			</button>

			{open && (
				<div className="flex flex-col gap-2 px-2 pb-1 text-[11px] text-muted-foreground">
					{p.upNext.length > 0 && (
						<div className="flex flex-col gap-0.5">
							<span className="uppercase tracking-wider">{p.phase === "revision" ? "Revise today" : "Up next"}</span>
							{p.upNext.map((f) => (
								<button
									key={f.title}
									type="button"
									disabled={!f.chatId}
									onClick={() => f.chatId && router.push(`/chat/${f.chatId}`)}
									className="flex items-baseline gap-2 rounded px-1 py-0.5 text-left text-foreground transition-colors hover:bg-accent disabled:hover:bg-transparent"
								>
									<span className="min-w-0 truncate">{f.title}</span>
									{f.review && <span className="shrink-0 text-amber-500">review</span>}
									<span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{hm(f.minutes)}</span>
								</button>
							))}
						</div>
					)}
					<span className="tabular-nums">
						Done {pct(p.ist)} of the plan; an even pace would be at {pct(p.soll)} this morning (the tick).
					</span>
					<span className="tabular-nums">
						This week {hm(p.minutesWeek)} of {hm(p.targetWeek)} · {p.focusesDone} of {p.focusesTotal} topics done · {p.restHours} h left
					</span>
					<span>
						{p.phase === "study"
							? `Today's target = ${p.restHours} h left ÷ ${p.daysLeft} study ${p.daysLeft === 1 ? "day" : "days"} until revision, recomputed every day (plan: ${hm(p.plannedPerDay)}/day).`
							: `Revision: ${hm(p.plannedPerDay)} a day on the shakiest topics, ${p.daysLeft} ${p.daysLeft === 1 ? "day" : "days"} left.`}
					</span>
				</div>
			)}
		</div>
	);
}

export function ExamProgress() {
	const exams = useExamProgress();
	if (exams.length === 0) return null;
	return (
		<section aria-label="Exam progress" className="flex flex-col gap-2 border-t border-border px-2 pb-1 pt-2">
			{exams.map((p) => (
				<ExamBlock key={`${p.exam}|${p.date}`} p={p} />
			))}
		</section>
	);
}
