"use client";

/**
 * Exam overview page (fork addition) — /exams, opened from the sidebar
 * strip's "Details". Per exam plan: where Paul stands against the line,
 * every topic with its own progress, and the next seven days as a plan.
 * Same numbers as the strip (GET /api/exam-progress, src/core/exam-progress.ts);
 * English like everything that plans for the exams.
 */

import { useState } from "react";
import Link from "next/link";
import { CalendarDaysIcon, CheckIcon, ChevronRightIcon, CircleDashedIcon, CircleDotIcon, FlagIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/top-bar";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { UNDERSTANDING_TARGET, type FocusView, type OpenQuestion, type OpenReason, type ScheduleDay } from "@/src/core";
import { type Active, hm, LineBar, pct, STANDING, standingLabel, useExamProgress } from "@/components/exam-progress";

/** "2026-11-03" → "Tue 3 Nov" (local calendar day, no time-zone shift). */
function dayLabel(iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }): string {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y!, m! - 1, d!).toLocaleDateString("en-GB", opts);
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-card/50 px-3 py-2.5">
			<span className="text-xs uppercase tracking-widest text-muted-foreground/70">{label}</span>
			<span className={cn("text-xl font-medium tabular-nums text-foreground", tone)}>{value}</span>
			{sub && <span className="text-xs tabular-nums text-muted-foreground">{sub}</span>}
		</div>
	);
}

function Meter({ value, className, label }: { value: number; className: string; label: string }) {
	return (
		<div className="h-1.5 w-full rounded-full bg-border" role="img" aria-label={label}>
			<div
				className={cn("h-full rounded-full transition-[width] duration-500", className)}
				style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
			/>
		</div>
	);
}

function topicStatus(f: FocusView): { label: string; icon: typeof CheckIcon; tone: string } {
	if (f.finished) return { label: "Done", icon: CheckIcon, tone: "text-green-500" };
	if (f.started) return { label: "In progress", icon: CircleDotIcon, tone: "text-foreground" };
	return { label: "Not started", icon: CircleDashedIcon, tone: "text-muted-foreground" };
}

function TopicRow({ f }: { f: FocusView }) {
	const status = topicStatus(f);
	const StatusIcon = status.icon;
	const weak = f.understanding !== null && f.understanding < UNDERSTANDING_TARGET;
	const body = (
		<>
			<span className="flex items-baseline gap-2 text-sm">
				<StatusIcon className={cn("size-3.5 shrink-0 translate-y-0.5", status.tone)} aria-label={status.label} />
				<span className="min-w-0 truncate font-medium text-foreground">{f.title}</span>
				{f.weight === "hoch" && <span className="shrink-0 text-xs text-amber-500">high weight</span>}
				<span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
					{hm(f.learningMinutes)} of {f.effortHours} h
				</span>
			</span>
			<span className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-x-3 gap-y-1.5 text-xs tabular-nums text-muted-foreground">
				<span>Worked through</span>
				<Meter value={f.progress} className="bg-foreground/70" label={`${pct(f.progress)} worked through`} />
				<span className="text-right">{pct(f.progress)}</span>
				<span>Understood</span>
				{f.understanding === null ? (
					<span className="col-span-2 text-muted-foreground/70">not enough answers yet</span>
				) : (
					<>
						<Meter value={f.understanding} className={weak ? "bg-amber-500" : "bg-green-500"} label={`${pct(f.understanding)} understood`} />
						<span className={cn("text-right", weak && "text-amber-500")}>{pct(f.understanding)}</span>
					</>
				)}
			</span>
			<span className="flex gap-3 text-xs tabular-nums text-muted-foreground">
				<span>{status.label}</span>
				{!f.finished && <span>· about {hm(f.restMinutes)} left</span>}
				{f.openQuestions > 0 && !f.chatId && <span className="text-amber-500">· {f.openQuestions} open {f.openQuestions === 1 ? "question" : "questions"}</span>}
			</span>
		</>
	);
	const cls = "flex flex-col gap-2 rounded-lg border border-border/60 bg-card/50 px-3 py-2.5 transition-colors";
	if (!f.chatId) return <div className={cls}>{body}</div>;
	// The list toggle sits OUTSIDE the link (no button inside an anchor).
	return (
		<div className="flex flex-col rounded-lg border border-border/60 bg-card/50">
			<Link
				href={`/chat/${f.chatId}`}
				className="flex flex-col gap-2 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				{body}
			</Link>
			{f.openQuestions > 0 && <OpenQuestions chatId={f.chatId} count={f.openQuestions} />}
		</div>
	);
}

const REASON_LABEL: Record<OpenReason, string> = {
	dontKnow: "don't know",
	incorrect: "wrong",
	lowConfidence: "right, but unsure",
};

/**
 * "N open questions" (Paul, 2026-11-09): opens the list of what is still
 * open in this topic's chat and why. Loaded on click from
 * /api/open-questions, so the texts never travel with the export. A
 * question closes when the tutor re-asks it and he answers right and sure.
 */
function OpenQuestions({ chatId, count }: { chatId: string; count: number }) {
	const [open, setOpen] = useState(false);
	const [list, setList] = useState<OpenQuestion[] | null>(null);
	const [failed, setFailed] = useState(false);
	const toggle = async () => {
		const next = !open;
		setOpen(next);
		if (!next) return;
		setFailed(false);
		try {
			const res = await fetch(`/api/open-questions?chatId=${encodeURIComponent(chatId)}`, { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setList((await res.json()) as OpenQuestion[]);
		} catch (err) {
			console.error("[open-questions]", err);
			setFailed(true);
		}
	};
	return (
		<div className="flex flex-col gap-2 border-t border-border/60 px-3 py-2 text-xs">
			<button
				type="button"
				onClick={() => void toggle()}
				aria-expanded={open}
				data-testid="open-questions-toggle"
				className="flex items-center gap-1 self-start rounded text-amber-500 transition-colors hover:text-amber-400"
			>
				<ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
				{count} open {count === 1 ? "question" : "questions"}
			</button>
			{open && (
				<div className="flex flex-col gap-2" data-testid="open-questions-list">
					{failed ? (
						<span className="text-muted-foreground">Could not load the questions.</span>
					) : list === null ? (
						<span className="text-muted-foreground">Loading…</span>
					) : (
						<>
							<ol className="flex max-h-96 flex-col gap-2 overflow-y-auto">
								{list.map((q) => (
									<li key={q.id} className="flex flex-col gap-0.5 rounded-md bg-background/40 px-2.5 py-1.5">
										<span className="text-[11px] uppercase tracking-widest text-amber-500/80">
											{REASON_LABEL[q.reason]}
											{q.answeredAt && <span className="normal-case tracking-normal text-muted-foreground/70"> · {new Date(q.answeredAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</span>}
										</span>
										<div className="text-sm text-foreground">
											<ToolContentResponse>{q.question}</ToolContentResponse>
										</div>
									</li>
								))}
							</ol>
							<span className="text-muted-foreground">
								To close them: open the chat and ask the tutor to go through your open questions. A question closes when you answer it
								right and sure.
							</span>
						</>
					)}
				</div>
			)}
		</div>
	);
}

function DayCard({ d, today }: { d: ScheduleDay; today: boolean }) {
	return (
		<div
			className={cn(
				"flex flex-col gap-2 rounded-lg border px-3 py-2.5",
				today ? "border-foreground/40 bg-accent/60" : "border-border/60 bg-card/50",
			)}
		>
			<span className="flex items-baseline gap-2 text-sm">
				<span className="font-medium text-foreground">{today ? "Today" : dayLabel(d.date)}</span>
				{d.phase === "revision" && (
					<span className="flex items-center gap-1 text-xs text-amber-500">
						<RotateCcwIcon className="size-3" /> revision
					</span>
				)}
				<span className="ml-auto text-xs tabular-nums text-muted-foreground">
					{d.minutes > 0 ? hm(d.minutes) : today ? "done ✓" : "free"}
				</span>
			</span>
			{d.items.length > 0 ? (
				<ul className="flex flex-col gap-1">
					{d.items.map((i) => (
						<li key={i.title} className="flex items-baseline gap-2 text-xs">
							{i.chatId ? (
								<Link href={`/chat/${i.chatId}`} className="min-w-0 truncate text-foreground hover:underline">
									{i.title}
								</Link>
							) : (
								<span className="min-w-0 truncate text-foreground">{i.title}</span>
							)}
							{i.review && d.phase === "study" && <span className="shrink-0 text-amber-500">review</span>}
							<span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{hm(i.minutes)}</span>
						</li>
					))}
				</ul>
			) : (
				<span className="text-xs text-muted-foreground">{today ? "Today's target is reached." : "Nothing planned — you are ahead."}</span>
			)}
		</div>
	);
}

function ExamCard({ p }: { p: Active }) {
	const s = STANDING[p.standing];
	const todayDone = p.leftToday === 0 && p.targetToday > 0;
	return (
		<article className="flex flex-col gap-6" aria-label={p.exam} data-testid="exam-overview-card">
			<header className="flex flex-col gap-3">
				<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<h2 className="font-title text-2xl tracking-tight text-foreground">{p.exam}</h2>
					<span className={cn("text-sm font-medium", s.tone)}>{standingLabel(p)}</span>
					<span className="ml-auto text-sm tabular-nums text-muted-foreground">
						{dayLabel(p.date, { weekday: "short", day: "numeric", month: "long" })} · in {p.daysToExam} {p.daysToExam === 1 ? "day" : "days"}
					</span>
				</div>
				<LineBar p={p} size="lg" />
				<span className="text-xs tabular-nums text-muted-foreground">
					{pct(p.ist)} of the plan done · an even pace would be at {pct(p.soll)} this morning (the tick)
				</span>
			</header>

			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				<Tile label="Done" value={pct(p.ist)} sub={`${p.focusesDone} of ${p.focusesTotal} topics`} />
				<Tile
					label="Understood"
					value={p.understanding === null ? "—" : pct(p.understanding)}
					sub={`target ${pct(UNDERSTANDING_TARGET)}`}
					tone={p.understanding !== null && p.understanding < UNDERSTANDING_TARGET ? "text-amber-500" : undefined}
				/>
				<Tile
					label="Today"
					value={hm(p.minutesToday)}
					sub={todayDone ? "target reached ✓" : `of ${hm(p.targetToday)} · ${hm(p.leftToday)} to go`}
					tone={todayDone ? "text-green-500" : undefined}
				/>
				<Tile label="This week" value={hm(p.minutesWeek)} sub={`of ${hm(p.targetWeek)}`} />
			</div>

			<section className="flex flex-col gap-3" aria-label="Plan for the next days">
				<h3 className="flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">
					<CalendarDaysIcon className="size-3.5" /> The next days
				</h3>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					{p.schedule.map((d, i) => (
						<DayCard key={d.date} d={d} today={i === 0} />
					))}
				</div>
				<div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-muted-foreground">
					{p.phase === "study" && (
						<span className="flex items-center gap-1">
							<RotateCcwIcon className="size-3" /> Revision from {dayLabel(p.reviewFrom)}
						</span>
					)}
					<span className="flex items-center gap-1">
						<FlagIcon className="size-3" /> Exam on {dayLabel(p.date)}
					</span>
					<span>About {p.restHours} h left at your pace</span>
				</div>
			</section>

			<section className="flex flex-col gap-3" aria-label="Topics">
				<h3 className="text-xs uppercase tracking-widest text-muted-foreground/70">Topics</h3>
				<div className="flex flex-col gap-2">
					{p.focuses.map((f) => (
						<TopicRow key={f.title} f={f} />
					))}
				</div>
			</section>

			<p className="text-xs leading-relaxed text-muted-foreground">
				How this is computed: a topic counts as done by how much of its session plan you worked through, times the
				share of right answers (from three graded answers on). The tick is a straight line from the plan&apos;s start to
				the first revision day. Each day asks for what is left at your measured pace, divided by the study days until
				revision — so the plan above is an estimate that is recomputed every day.
			</p>
		</article>
	);
}

export function ExamOverview() {
	const { exams, loaded } = useExamProgress();
	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<span className="font-title text-lg tracking-tight">Exams</span>
			</TopBar>
			<main className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-14 px-4 py-8 sm:px-6">
					{!loaded ? (
						<p className="text-sm text-muted-foreground">Loading…</p>
					) : exams.length === 0 ? (
						<div className="flex flex-col gap-2 text-sm text-muted-foreground" data-testid="exam-overview-empty">
							<p className="text-foreground">No exam plan is running.</p>
							<p>
								Plan an exam with Claude: the plan lands in your Second Brain under LearnHarness/Auftraege, and its topics
								become sessions here at the next start.
							</p>
						</div>
					) : (
						exams.map((p) => <ExamCard key={`${p.exam}|${p.date}`} p={p} />)
					)}
				</div>
			</main>
		</div>
	);
}
