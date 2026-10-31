/**
 * Study timer (fork addition): the floating timer's state and actions.
 *   GET  ?chatId=…  → what the timer shows for the chat on screen.
 *   POST { action: "start" | "toggle" | "switch", chatId? }
 *        { action: "pause" }
 *        { action: "beat", activeAt }      (every 30 s while running)
 *        { action: "assign", chatId, subject }
 * Rules: src/core/study-timer.ts; storage: src/server/study-timer.ts.
 */
import { TimerActionError, parseTimerAction, studyTimerAction, studyTimerView } from "@/src/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export function GET(request: Request) {
	const chatId = new URL(request.url).searchParams.get("chatId")?.trim() || null;
	try {
		return Response.json(studyTimerView(chatId), { headers: NO_STORE });
	} catch (err) {
		console.error("[study-timer] read failed:", err);
		return Response.json({ error: "study timer unavailable" }, { status: 500 });
	}
}

export async function POST(request: Request) {
	try {
		const action = parseTimerAction(await request.json().catch(() => null));
		return Response.json(studyTimerAction(action), { headers: NO_STORE });
	} catch (err) {
		if (err instanceof TimerActionError) return Response.json({ error: err.message }, { status: 400 });
		console.error("[study-timer] action failed:", err);
		return Response.json({ error: "study timer unavailable" }, { status: 500 });
	}
}
