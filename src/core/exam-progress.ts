/**
 * Exam progress (fork addition) — PURE: where Paul stands against his exam
 * plan, and what today asks of him. Feeds the sidebar's progress strip.
 *
 * Two questions, answered separately on purpose:
 *  1. Am I where I should be? IST is the share of the planned effort behind
 *     him (progress × understanding per focus, weighted by effort). SOLL is
 *     a straight line from the plan's start to the first revision day: at
 *     the start of a day he should have covered the days already gone. The
 *     gap in hours — (ist − soll) × total effort — is the headline number.
 *  2. What does today ask? The same arithmetic as Daily's exam planner
 *     (morning-dashboard src/lib/klausurPlaner.ts, kept in step with it):
 *     the remaining effort, spread over the study days left, recomputed
 *     every day — ahead yesterday means a smaller target today.
 *
 * Understanding is shown on its own (effort-weighted share of right
 * answers): covering ground fast but retaining little must stay visible.
 */

import type { ExamSummary } from "./brain-export.ts";

type Focus = ExamSummary["focuses"][number];

/** Without an effort line a focus counts this many hours (as in Daily). */
const DEFAULT_EFFORT_H = 4;
const SURCHARGE_PER_QUESTION_H = 0.25;
const SURCHARGE_MAX_H = 2;
const DEFAULT_REVIEW_DAYS = 14;
const DEFAULT_HOURS_PER_WEEK = 14;
const MAX_FOCUSES_TODAY = 3;
const MIN_BLOCK_MIN = 30;
/** A focus counts as finished at this share done with nothing open. */
const FINISHED_AT = 0.9;
const REVIEW_AT_QUESTIONS = 3;
/** The understanding the plan aims for. */
export const UNDERSTANDING_TARGET = 0.8;
/** On track within this many hours of the line (or 3 % of the plan, if larger). */
const TOLERANCE_MIN_H = 1;
const TOLERANCE_SHARE = 0.03;

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const daysBetween = (from: string, to: string) => Math.round((day(to) - day(from)) / DAY_MS);
const plusDays = (iso: string, n: number) => new Date(day(iso) + n * DAY_MS).toISOString().slice(0, 10);
const to15 = (min: number) => Math.max(0, Math.ceil(min / 15) * 15);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type Standing = "ahead" | "on-track" | "behind" | "far-behind";

export interface TodayFocus {
	title: string;
	chatId?: string;
	minutes: number;
	review: boolean;
}

export type ExamProgress =
	| { exam: string; phase: "no-date" | "over" }
	| {
			exam: string;
			date: string;
			phase: "study" | "revision";
			daysToExam: number;
			/** Study days until revision (study) or until the exam (revision). */
			daysLeft: number;
			totalHours: number;
			restHours: number;
			/** 0…1 of the planned effort behind him. */
			ist: number;
			/** 0…1 where the straight line says he should be this morning. */
			soll: number;
			/** (ist − soll) × total effort, in hours; positive = ahead. */
			deltaHours: number;
			standing: Standing;
			/** Effort-weighted share of right answers; null before any is graded. */
			understanding: number | null;
			/** Today's target in minutes, rounded up to 15. */
			targetToday: number;
			minutesToday: number;
			leftToday: number;
			targetWeek: number;
			minutesWeek: number;
			/** The plan's own daily measure (hours per week / 7), minutes. */
			plannedPerDay: number;
			upNext: TodayFocus[];
			focusesDone: number;
			focusesTotal: number;
	  };

export interface ProgressInput {
	exam: ExamSummary & { focuses: Array<Focus & { chatId?: string }> };
	/** First day of the plan (YYYY-MM-DD); null = today. */
	planStart: string | null;
	/** YYYY-MM-DD, local time. */
	today: string;
	minutesToday: number;
	minutesWeek: number;
}

/** Remaining effort of a focus, in hours. */
export function restHours(f: Focus): number {
	const effort = f.effortHours ?? DEFAULT_EFFORT_H;
	const surcharge = Math.min(f.openQuestions * SURCHARGE_PER_QUESTION_H, SURCHARGE_MAX_H);
	return effort * (1 - f.done) + surcharge;
}

export const isFinished = (f: Focus) => f.done >= FINISHED_AT && f.openQuestions === 0;

/** Study phase: started, unfinished focuses first, then the plan's order. */
function studyOrder<T extends Focus>(focuses: T[]): T[] {
	const open = focuses.filter((f) => !isFinished(f));
	return [...open.filter((f) => f.started), ...open.filter((f) => !f.started)];
}

/** Revision: the shakiest first. */
function revisionOrder<T extends Focus>(focuses: T[]): T[] {
	const shaky = (f: Focus) => (1 - (f.understanding ?? f.done)) + f.openQuestions * 0.1 + (f.weight === "hoch" ? 0.2 : 0);
	return [...focuses].sort((a, b) => shaky(b) - shaky(a));
}

function distribute(order: Array<Focus & { chatId?: string }>, budget: number, revision: boolean): TodayFocus[] {
	const out: TodayFocus[] = [];
	let rest = budget;
	for (const f of order) {
		if (rest < MIN_BLOCK_MIN || out.length >= MAX_FOCUSES_TODAY) break;
		const need = revision ? rest : Math.max(MIN_BLOCK_MIN, to15(restHours(f) * 60));
		const minutes = Math.min(need, to15(rest));
		out.push({ title: f.title, ...(f.chatId ? { chatId: f.chatId } : {}), minutes, review: revision || f.openQuestions >= REVIEW_AT_QUESTIONS });
		rest -= minutes;
	}
	return out;
}

export function standingOf(deltaHours: number, totalHours: number): Standing {
	const tolerance = Math.max(TOLERANCE_MIN_H, totalHours * TOLERANCE_SHARE);
	if (deltaHours > tolerance) return "ahead";
	if (deltaHours >= -tolerance) return "on-track";
	if (deltaHours >= -3 * tolerance) return "behind";
	return "far-behind";
}

export function examProgress({ exam, planStart, today, minutesToday, minutesWeek }: ProgressInput): ExamProgress {
	if (!exam.date) return { exam: exam.exam, phase: "no-date" };
	const daysToExam = daysBetween(today, exam.date);
	if (daysToExam < 0) return { exam: exam.exam, phase: "over" };

	const reviewFrom = exam.reviewFrom ?? plusDays(exam.date, -DEFAULT_REVIEW_DAYS);
	const hoursPerWeek = exam.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK;
	const plannedPerDay = (hoursPerWeek * 60) / 7;
	const effort = (f: Focus) => f.effortHours ?? DEFAULT_EFFORT_H;
	const total = exam.focuses.reduce((s, f) => s + effort(f), 0);
	const rest = exam.focuses.reduce((s, f) => s + restHours(f), 0);
	const ist = total > 0 ? exam.focuses.reduce((s, f) => s + effort(f) * f.done, 0) / total : 0;

	// The line runs from the plan's start to the first revision day.
	const start = planStart && planStart < reviewFrom ? planStart : today;
	const span = Math.max(1, daysBetween(start, reviewFrom));
	const soll = Math.min(1, Math.max(0, daysBetween(start, today) / span));
	const deltaHours = (ist - soll) * total;

	const graded = exam.focuses.filter((f) => f.understanding !== null);
	const gradedEffort = graded.reduce((s, f) => s + effort(f), 0);
	const understanding = gradedEffort > 0 ? graded.reduce((s, f) => s + effort(f) * (f.understanding as number), 0) / gradedEffort : null;

	const study = today < reviewFrom;
	let targetToday: number;
	let daysLeft: number;
	if (study) {
		daysLeft = Math.max(1, daysBetween(today, reviewFrom));
		// Today's minutes count back into the rest, or the target would
		// shrink twice (once via progress, once via the clock).
		targetToday = to15((rest * 60 + minutesToday) / daysLeft);
	} else {
		daysLeft = Math.max(1, daysToExam);
		targetToday = to15(plannedPerDay);
	}
	const leftToday = Math.max(0, targetToday - minutesToday);
	const order = study ? studyOrder(exam.focuses) : revisionOrder(exam.focuses);

	return {
		exam: exam.exam,
		date: exam.date,
		phase: study ? "study" : "revision",
		daysToExam,
		daysLeft,
		totalHours: round1(total),
		restHours: round1(rest),
		ist: round2(ist),
		soll: round2(soll),
		deltaHours: round1(deltaHours),
		standing: standingOf(deltaHours, total),
		understanding: understanding === null ? null : round2(understanding),
		targetToday,
		minutesToday,
		leftToday,
		targetWeek: Math.round(hoursPerWeek * 60),
		minutesWeek,
		plannedPerDay: Math.round(plannedPerDay),
		upNext: distribute(order, leftToday, !study),
		focusesDone: exam.focuses.filter(isFinished).length,
		focusesTotal: exam.focuses.length,
	};
}

/** Monday of the week of `iso`. */
export function weekStart(iso: string): string {
	const weekday = new Date(day(iso)).getUTCDay(); // 0 = Sunday
	return plusDays(iso, -((weekday + 6) % 7));
}

/** Minutes today and since Monday from a day → minutes map. */
export function minutesTodayAndWeek(byDay: Readonly<Record<string, number>>, today: string): { today: number; week: number } {
	const monday = weekStart(today);
	let week = 0;
	for (const [d, m] of Object.entries(byDay)) if (d >= monday && d <= today) week += m;
	return { today: byDay[today] ?? 0, week };
}
