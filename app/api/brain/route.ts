/**
 * Second Brain link (fork addition).
 *   GET  → the current status (Settings → Second Brain shows it).
 *   POST → { action: "start" }  once per app start (the window calls it on
 *          load): import new/changed notes, then export.
 *          { action: "resync" } after the folder setting changed: run again.
 * Returns immediately; the work runs in the background.
 */
import { brainStatus, startBrainSync } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(brainStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	const body = (await request.json().catch(() => ({}))) as { action?: unknown };
	if (body.action !== "start" && body.action !== "resync") {
		return Response.json({ error: "action must be \"start\" or \"resync\"" }, { status: 400 });
	}
	void startBrainSync({ force: body.action === "resync" }).catch((err) => {
		console.error("[brain] sync failed:", err);
	});
	return Response.json(brainStatus(), { headers: { "Cache-Control": "no-store" } });
}
