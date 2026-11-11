"use client";

/**
 * All · one button per running exam (fork addition, Paul 2026-11-11). The
 * same control sits in the open exam notch and above the sidebar's chat
 * list; both drive the one shared choice (components/chosen-exam.ts), so
 * the chats on the left, the graph and the notch always show one subject.
 * Styled like the sidebar's Teaching / Practice / All row.
 */

import { cn } from "@/lib/utils";

export function ExamSwitcher({
	exams,
	chosen,
	onChoose,
	className,
}: {
	exams: ReadonlyArray<{ exam: string; daysToExam: number }>;
	chosen: string | null;
	onChoose: (exam: string | null) => void;
	className?: string;
}) {
	if (exams.length < 2) return null;
	const names = [null, ...[...exams].sort((a, b) => a.daysToExam - b.daysToExam).map((e) => e.exam)];
	return (
		<div
			role="group"
			aria-label="Subject"
			className={cn("flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5", className)}
			data-testid="exam-switcher"
		>
			{names.map((name) => {
				const on = chosen === name;
				return (
					<button
						key={name ?? "all"}
						type="button"
						aria-pressed={on}
						onClick={() => onChoose(name)}
						data-testid={`exam-switch-${name ?? "all"}`}
						className={cn(
							"min-w-0 flex-1 truncate rounded-sm px-2 py-1 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							on ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{name ?? "All"}
					</button>
				);
			})}
		</div>
	);
}
