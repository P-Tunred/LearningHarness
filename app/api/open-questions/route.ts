/**
 * Open questions (fork addition): the open questions of one chat — the
 * exam overview's list behind "N open questions", fetched on click.
 *   GET ?chatId=… → OpenQuestion[] (src/core/open-questions.ts); 404 for
 *   an unknown chat.
 */
import { openQuestionsOf } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
	try {
		const open = openQuestionsOf(chatId);
		if (!open) return Response.json({ error: "chat not found" }, { status: 404 });
		return Response.json(open, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		console.error("[open-questions] failed:", err);
		return Response.json({ error: "open questions unavailable" }, { status: 500 });
	}
}
