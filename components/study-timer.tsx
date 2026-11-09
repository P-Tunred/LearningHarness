"use client";

/**
 * Study timer (fork addition) — a small floating timer at the bottom right.
 * The clock is the CURRENT STUDY SESSION (Paul, 2026-11-04): Start / Pause
 * (a break) / Resume (Mod+Shift+T does the same), and Save ends the session
 * and books it — the clock goes back to 00:00 for the next one. Beside it,
 * today's total. A click on the clock opens a small box: this session (since
 * when), today in total and per subject, when he learned (blocks) and what
 * he saved today; there the subject can be changed. Daily takes saved
 * sessions over from the brain export as its own study time.
 *
 * It never starts by itself. While it runs, the window beats every 30 s
 * with the time of the last input; the server ends the run on its own
 * after sleep, quit, or 20 min without input (asking "Still there?" at
 * 15). Rules: src/core/study-timer.ts. English like the rest of the app.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { BEAT_MS, IDLE_ASK_MS, kbdEventForAction } from "@/src/core";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { useServerEvent, useServerResync } from "@/components/server-events";

interface TimerView {
	running: boolean;
	subject: string | null;
	chatId: string | null;
	todayMs: number;
	runningSince: number | null;
	activeAt: number | null;
	askIdle: boolean;
	stopped: "idle" | "asleep" | null;
	choices: string[];
	unsavedMs: number;
	unsavedNoSubjectMs: number;
	saved?: Array<{ subject: string; day: string; minutes: number }>;
	summary: {
		sessionMs: number;
		sessionStart: number | null;
		todayTotalMs: number;
		todayBySubject: Array<{ subject: string | null; ms: number }>;
		todayBlocks: Array<{ subject: string | null; start: number; end: number; saved: boolean }>;
		savedToday: Array<{ subject: string; minutes: number; start: number; end: number; savedAt: number }>;
	};
	now: number;
}

type Body =
	| { action: "start" | "toggle" | "switch"; chatId: string | null }
	| { action: "pause" | "save" }
	| { action: "beat"; activeAt: number }
	| { action: "assign"; chatId: string | null; subject: string | null };

/** Input that counts as "still learning". Pointer moves are frequent but
 *  only write a number into a ref. */
const ACTIVITY_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"] as const;
/** A 1 s tick that took this long means the machine was asleep. */
const WAKE_GAP_MS = 60_000;
/** How long the "Saved …" line stays. */
const SAVED_NOTICE_MS = 10_000;

/** "42 min", "1 h 05" */
function duration(minutes: number): string {
	return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** What Save reports back, in one quiet line. */
function savedNotice(v: TimerView): string {
	const parts = (v.saved ?? []).map((s) => `${s.subject} ${duration(s.minutes)}`);
	const missing = Math.round(v.unsavedNoSubjectMs / 60_000);
	const head = parts.length ? `Saved: ${parts.join(" · ")} — reaches Daily within the hour` : "Nothing new to save";
	return missing > 0 ? `${head}. ${duration(missing)} without a subject: pick one, then save again.` : head;
}

function clock(ms: number): string {
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** "09:41" in local time. */
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const minutesOf = (ms: number) => Math.round(ms / 60_000);

const chatIdFrom = (pathname: string | null) => /^\/chat\/([^/]+)$/.exec(pathname ?? "")?.[1] ?? null;

function useStudyTimer(chatId: string | null) {
	const [view, setView] = useState<TimerView | null>(null);
	const [error, setError] = useState(false);
	const activeAt = useRef(Date.now());
	// The server's clock vs ours: the display ticks from the server's `now`.
	const skew = useRef(0);

	const adopt = useCallback((v: TimerView) => {
		skew.current = v.now - Date.now();
		setView(v);
		setError(false);
	}, []);

	const post = useCallback(async (body: Body): Promise<TimerView | null> => {
		try {
			const res = await fetch("/api/study-timer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const v = (await res.json()) as TimerView;
			adopt(v);
			return v;
		} catch (err) {
			console.error("[study-timer]", err);
			setError(true);
			return null;
		}
	}, [adopt]);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/study-timer${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ""}`, { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			adopt((await res.json()) as TimerView);
		} catch (err) {
			console.error("[study-timer]", err);
			setError(true);
		}
	}, [chatId, adopt]);

	// The chat on screen changed (or the window just loaded): the read
	// itself moves a running timer to it — the server ends the old piece —
	// and a paused one just shows the new subject.
	const running = view?.running ?? false;
	useEffect(() => {
		void load();
	}, [load]);

	useServerEvent("study-timer-changed", () => void load());
	useServerResync(() => void load());

	// Input anywhere in the window counts as being there.
	useEffect(() => {
		const mark = () => { activeAt.current = Date.now(); };
		for (const type of ACTIVITY_EVENTS) window.addEventListener(type, mark, { passive: true });
		document.addEventListener("scroll", mark, { passive: true, capture: true });
		return () => {
			for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, mark);
			document.removeEventListener("scroll", mark, { capture: true });
		};
	}, []);

	// Heartbeat while running. After sleep the first beat arrives late and
	// the server pauses the run at the last beat.
	useEffect(() => {
		if (!running) return;
		const id = setInterval(() => void post({ action: "beat", activeAt: activeAt.current + skew.current }), BEAT_MS);
		return () => clearInterval(id);
	}, [running, post]);

	// Re-render every second while running (the clock), and so the idle
	// question appears on time between beats.
	// A long gap between ticks means the machine slept: beat at once, so
	// the server pauses the run instead of the clock showing the sleep.
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!running) return;
		let last = Date.now();
		const id = setInterval(() => {
			const gap = Date.now() - last;
			last = Date.now();
			if (gap > WAKE_GAP_MS) void post({ action: "beat", activeAt: activeAt.current + skew.current });
			setTick((t) => t + 1);
		}, 1000);
		return () => clearInterval(id);
	}, [running, post]);

	const confirmPresence = useCallback(() => {
		activeAt.current = Date.now();
		void post({ action: "beat", activeAt: activeAt.current + skew.current });
	}, [post]);

	const now = Date.now() + skew.current;
	const sinceRead = view?.running ? Math.max(0, now - view.now) : 0;
	const session = view ? view.summary.sessionMs + sinceRead : 0;
	const today = view ? view.summary.todayTotalMs + sinceRead : 0;
	const askIdle = !!view?.running && (view.askIdle || Date.now() - activeAt.current >= IDLE_ASK_MS);
	return { view, error, session, today, sinceRead, askIdle, post, confirmPresence };
}

export function StudyTimer() {
	const pathname = usePathname();
	const chatId = chatIdFrom(pathname);
	const { view, error, session, today, sinceRead, askIdle, post, confirmPresence } = useStudyTimer(chatId);
	const [picking, setPicking] = useState(false);
	const [boxOpen, setBoxOpen] = useState(false);
	const [custom, setCustom] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);
	const closePicker = useCallback(() => { setPicking(false); setCustom(""); }, []);
	const closeAll = useCallback(() => { closePicker(); setBoxOpen(false); }, [closePicker]);
	usePopoverDismiss(rootRef, picking || boxOpen, closeAll);

	const toggle = useCallback(() => void post({ action: "toggle", chatId }), [post, chatId]);
	const [notice, setNotice] = useState<string | null>(null);
	const saveSession = useCallback(async () => {
		const v = await post({ action: "save" });
		if (v) setNotice(savedNotice(v));
	}, [post]);
	useEffect(() => {
		if (!notice) return;
		const id = setTimeout(() => setNotice(null), SAVED_NOTICE_MS);
		return () => clearTimeout(id);
	}, [notice]);
	useEffect(() => {
		const onKbd = () => toggle();
		const name = kbdEventForAction("toggle-study-timer");
		window.addEventListener(name, onKbd);
		return () => window.removeEventListener(name, onKbd);
	}, [toggle]);

	if (!view) return null;
	const target = chatId ?? view.chatId;
	const assign = (subject: string | null) => {
		void post({ action: "assign", chatId: target, subject });
		closePicker();
	};
	const subjectLabel = view.subject ?? "No subject";

	return (
		<>
		<StudyAura on={view.running} />
		<div
			ref={rootRef}
			data-testid="study-timer"
			// Bottom right on the stats-bar line, in the gutter beside the
			// centered chat column — where it is never over the input. Too
			// narrow for that gutter: top right under the title bar instead
			// (panels then open downwards), and from 1400 px the subject is
			// spelled out; below that it sits in the tooltip and the picker.
			className="pointer-events-auto fixed right-3 top-[4.25rem] z-30 flex flex-col-reverse items-end gap-1.5 min-[1100px]:bottom-3 min-[1100px]:top-auto min-[1100px]:flex-col"
		>
			{picking && (
				<div role="dialog" aria-label="Book this chat to" className="w-56 rounded-xl border bg-card p-1.5 text-xs shadow-xl">
					<p className="px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground">Book this chat to</p>
					<div className="flex max-h-56 flex-col overflow-y-auto">
						{view.choices.map((c) => (
							<button
								key={c}
								type="button"
								onClick={() => assign(c)}
								className={cn("truncate rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent", c === view.subject ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
							>
								{c}
							</button>
						))}
						<button
							type="button"
							onClick={() => assign(null)}
							className="rounded-lg px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							No subject
						</button>
					</div>
					<form
						className="mt-1 border-t border-border/60 pt-1.5"
						onSubmit={(e) => {
							e.preventDefault();
							if (custom.trim()) assign(custom.trim());
						}}
					>
						<input
							value={custom}
							onChange={(e) => setCustom(e.target.value)}
							placeholder="New subject…"
							maxLength={120}
							className="w-full rounded-lg bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:bg-accent"
						/>
					</form>
				</div>
			)}

			{boxOpen && !picking && (
				<TimerBox
					view={view}
					session={session}
					today={today}
					sinceRead={sinceRead}
					subjectLabel={subjectLabel}
					onChangeSubject={() => setPicking(true)}
				/>
			)}

			{askIdle && (
				<button
					type="button"
					onClick={confirmPresence}
					className="rounded-lg border bg-card px-3 py-1.5 text-xs text-foreground shadow-md transition-colors hover:bg-accent"
				>
					Still there? <span className="text-muted-foreground">Yes, keep going</span>
				</button>
			)}

			<div className="flex items-center gap-2 rounded-full border bg-card/90 py-1 pl-3 pr-1 text-xs shadow-md backdrop-blur">
				<span
					aria-hidden="true"
					className={cn("size-1.5 shrink-0 rounded-full", view.running ? "bg-green-500" : view.subject ? "bg-muted-foreground/40" : "bg-amber-500")}
				/>
				<button
					type="button"
					onClick={() => { setBoxOpen((o) => !o); setPicking(false); }}
					aria-expanded={boxOpen}
					aria-haspopup="dialog"
					data-testid="study-timer-open"
					aria-label={`This session ${clock(session)}, today ${duration(minutesOf(today))} (${subjectLabel}). Show details`}
					title={`${subjectLabel} — this session. Click for today's details.`}
					className={cn("flex items-baseline gap-2 rounded px-0.5 transition-colors hover:text-foreground", view.subject ? "text-muted-foreground" : "text-amber-500")}
				>
					<span className="hidden max-w-40 truncate min-[1400px]:inline">{subjectLabel}</span>
					<span className="tabular-nums text-foreground" data-testid="study-timer-session">{clock(session)}</span>
					<span className="hidden tabular-nums text-muted-foreground min-[1100px]:inline">today {duration(minutesOf(today))}</span>
				</button>
				<button
					type="button"
					onClick={toggle}
					data-testid="study-timer-toggle"
					className="rounded-full px-2.5 py-1 text-foreground transition-colors hover:bg-accent"
				>
					{view.running ? "Pause" : session > 0 ? "Resume" : "Start"}
				</button>
				{(view.running || view.unsavedMs + view.unsavedNoSubjectMs > 0) && (
					<button
						type="button"
						onClick={() => void saveSession()}
						data-testid="study-timer-save"
						title="End this study session and save it — Daily counts it as study time"
						className="rounded-full px-2.5 py-1 text-foreground transition-colors hover:bg-accent"
					>
						Save
					</button>
				)}
			</div>
			{notice && (
				<p role="status" className="max-w-72 rounded bg-background/80 px-2 text-right text-[11px] text-muted-foreground">
					{notice}
				</p>
			)}
			{(error || (!view.running && view.stopped === "idle")) && (
				<p className="rounded bg-background/80 px-2 text-[11px] text-muted-foreground">
					{error ? "Timer unreachable — time is not being saved" : "Paused after 20 min without input"}
				</p>
			)}
		</div>
		</>
	);
}

/**
 * Aura (Paul, 2026-11-09): while the clock runs, a very faint green glow
 * along the inside of the whole window edge, so a glance tells whether
 * time is being counted; paused or stopped, no color at all. Purely
 * visual — clicks pass through.
 */
function StudyAura({ on }: { on: boolean }) {
	return (
		<div
			aria-hidden="true"
			data-testid="study-aura"
			data-on={on ? "true" : "false"}
			className={cn(
				"pointer-events-none fixed inset-0 z-40 transition-opacity duration-700 ease-out",
				"shadow-[inset_0_0_14px_2px_rgb(34_197_94/0.28),inset_0_0_0_1px_rgb(34_197_94/0.22)]",
				on ? "opacity-100" : "opacity-0",
			)}
		/>
	);
}

/** The expanded box: this session, today, when he learned, what he saved. */
function TimerBox({
	view,
	session,
	today,
	sinceRead,
	subjectLabel,
	onChangeSubject,
}: {
	view: TimerView;
	session: number;
	today: number;
	sinceRead: number;
	subjectLabel: string;
	onChangeSubject: () => void;
}) {
	const sum = view.summary;
	// The running block grows with the clock between server reads.
	const blocks = sum.todayBlocks.map((b, i) =>
		view.running && i === sum.todayBlocks.length - 1 && !b.saved ? { ...b, end: b.end + sinceRead } : b,
	);
	const bySubject = sum.todayBySubject.map((x) =>
		view.running && x.subject === view.subject ? { ...x, ms: x.ms + sinceRead } : x,
	);
	const label = "text-[11px] uppercase tracking-widest text-muted-foreground/70";
	return (
		<div role="dialog" aria-label="Study time" data-testid="study-timer-box" className="flex w-72 flex-col gap-3 rounded-xl border bg-card p-3 text-xs shadow-xl">
			<section className="flex flex-col gap-1">
				<span className={label}>This session</span>
				<span className="flex items-baseline gap-2">
					<span className="text-lg font-medium tabular-nums text-foreground">{clock(session)}</span>
					<span className="text-muted-foreground">
						{sum.sessionStart === null ? "not started" : `since ${hhmm(sum.sessionStart)}`}
						{" · "}
						{view.running ? <span className="text-green-500">running</span> : sum.sessionStart === null ? "press Start" : "paused"}
					</span>
				</span>
				<span className="flex items-baseline gap-2 text-muted-foreground">
					<span className={cn("min-w-0 truncate", !view.subject && "text-amber-500")}>{subjectLabel}</span>
					<button type="button" onClick={onChangeSubject} className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-foreground transition-colors hover:bg-accent">
						Change subject
					</button>
				</span>
			</section>

			<section className="flex flex-col gap-1">
				<span className="flex items-baseline">
					<span className={label}>Today</span>
					<span className="ml-auto tabular-nums text-foreground">{duration(minutesOf(today))}</span>
				</span>
				{bySubject.length === 0 ? (
					<span className="text-muted-foreground">Nothing measured yet.</span>
				) : (
					bySubject.map((x) => (
						<span key={x.subject ?? "-"} className="flex items-baseline gap-2 text-muted-foreground">
							<span className={cn("min-w-0 truncate", !x.subject && "text-amber-500")}>{x.subject ?? "No subject"}</span>
							<span className="ml-auto tabular-nums">{duration(minutesOf(x.ms))}</span>
						</span>
					))
				)}
			</section>

			{blocks.length > 0 && (
				<section className="flex flex-col gap-1">
					<span className={label}>When you learned</span>
					<ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
						{blocks.map((b) => (
							<li key={b.start} className="flex items-baseline gap-2 tabular-nums text-muted-foreground">
								<span className="text-foreground">{hhmm(b.start)}–{hhmm(b.end)}</span>
								<span className="min-w-0 truncate">{b.subject ?? "No subject"}</span>
								<span className={cn("ml-auto shrink-0", b.saved ? "text-green-500" : "text-muted-foreground/70")}>{b.saved ? "saved" : "open"}</span>
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="flex flex-col gap-1">
				<span className={label}>Saved today</span>
				{sum.savedToday.length === 0 ? (
					<span className="text-muted-foreground">Nothing saved yet — Save ends a session.</span>
				) : (
					<ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
						{sum.savedToday.map((x) => (
							<li key={`${x.savedAt}|${x.subject}`} className="flex items-baseline gap-2 tabular-nums text-muted-foreground">
								<span className="text-foreground">{hhmm(x.savedAt)}</span>
								<span className="min-w-0 truncate">{x.subject}</span>
								<span className="ml-auto shrink-0" title={`${hhmm(x.start)}–${hhmm(x.end)}`}>{duration(x.minutes)}</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
