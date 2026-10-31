"use client";
/**
 * Second Brain link (fork addition): asks the server once per window load to
 * run the start-up sync (import new/changed notes, then export). The server
 * runs it at most once per app start, so reloads and extra windows are free.
 */
import { useEffect } from "react";

export function BrainSync() {
	useEffect(() => {
		void fetch("/api/brain", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "start" }),
		}).catch(() => {/* status stays visible in Settings → Second Brain */});
	}, []);
	return null;
}
