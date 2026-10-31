/**
 * Exam progress (fork addition): where Paul stands on each exam plan from
 * the brain — the sidebar's progress strip reads it.
 *   GET → ExamProgress[] (empty without a brain folder or plans).
 */
import { examProgressNow } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	try {
		return Response.json(examProgressNow(), { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		console.error("[exam-progress] failed:", err);
		return Response.json({ error: "exam progress unavailable" }, { status: 500 });
	}
}
