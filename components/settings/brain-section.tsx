"use client";
/**
 * Settings → Second Brain (fork addition): the brain folder and the live
 * sync status. Saving a folder triggers a resync (import + export); the
 * status polls while the section is open.
 */
import { useEffect, useState } from "react";
import type { BrainSettings } from "@/src/core";
import { CommitInput, SettingsRow } from "./controls.tsx";

interface BrainStatusView {
	folder: string | null;
	phase: "off" | "idle" | "importing" | "exporting" | "error";
	error?: string;
	lastExportAt?: string;
	exportedFiles?: number;
	conflicts?: string[];
	import?: { total: number; done: number; failed: number; current?: string; finishedAt?: string };
}

const POLL_MS = 2_000;

function time(iso: string | undefined): string {
	return iso ? new Date(iso).toLocaleString() : "–";
}

/** One status line for the current phase. Exported for tests. */
export function brainPhaseLine(s: BrainStatusView | null): string {
	if (!s) return "Status wird geladen…";
	switch (s.phase) {
		case "off":
			return "Aus: Trage einen Ordner ein, um dein Second Brain zu verbinden.";
		case "importing": {
			const i = s.import;
			return i ? `Lese Notizen ein: ${i.done} von ${i.total}${i.current ? ` (${i.current})` : ""}` : "Lese Notizen ein…";
		}
		case "exporting":
			return "Schreibe Lern-Notizen ins Brain…";
		case "error":
			return `Fehler: ${s.error ?? "unbekannt"}`;
		case "idle":
			return `Verbunden. Letzter Export: ${time(s.lastExportAt)} (${s.exportedFiles ?? 0} Dateien)`;
	}
}

export function BrainSection({
	brain,
	onSectionChange,
}: {
	brain: BrainSettings | undefined;
	onSectionChange: (next: BrainSettings) => Promise<void> | void;
}) {
	const [status, setStatus] = useState<BrainStatusView | null>(null);

	useEffect(() => {
		let alive = true;
		const load = () =>
			fetch("/api/brain", { cache: "no-store" })
				.then((r) => (r.ok ? r.json() : null))
				.then((s: BrainStatusView | null) => { if (alive && s) setStatus(s); })
				.catch(() => {});
		void load();
		const timer = setInterval(load, POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, []);

	const lastImport = status?.import?.finishedAt
		? `${time(status.import.finishedAt)}: ${status.import.total} neu/geändert${status.import.failed ? `, ${status.import.failed} fehlgeschlagen` : ""}`
		: "–";

	return (
		<>
			<SettingsRow
				label="Brain-Ordner"
				hint="Ordner mit deinen Markdown-Notizen (z. B. in Google Drive). Leer = aus."
				testid="row-brain-folder"
			>
				<CommitInput
					wide
					value={brain?.folder ?? ""}
					placeholder="~/Library/CloudStorage/GoogleDrive-…/Meine Ablage/Brain"
					ariaLabel="brain folder path"
					testid="input-brain-folder"
					onCommit={async (v) => {
						await onSectionChange(v === "" ? { folder: null } : { folder: v });
						void fetch("/api/brain", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ action: "resync" }),
						}).catch(() => {});
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Status" testid="row-brain-status">
				<span className="max-w-96 text-right font-ui text-xs text-muted-foreground" data-testid="brain-status">
					{brainPhaseLine(status)}
				</span>
			</SettingsRow>
			<SettingsRow label="Letzter Import" testid="row-brain-import">
				<span className="font-ui text-xs text-muted-foreground">{lastImport}</span>
			</SettingsRow>
			{status?.conflicts && status.conflicts.length > 0 && (
				<SettingsRow label="Übersprungen" hint="Dort liegt schon eine Datei, die nicht von LearnHarness stammt." testid="row-brain-conflicts">
					<span className="max-w-96 text-right font-ui text-xs text-muted-foreground">{status.conflicts.join(", ")}</span>
				</SettingsRow>
			)}
			<p className="mt-3 font-ui text-xs text-muted-foreground">
				LearnHarness schreibt deine Sessions und Aussagen nach „LearnHarness/“ in diesem Ordner
				(plus learnharness-stats.json fürs Dashboard) und liest beim App-Start neue oder geänderte
				Notizen ein. Der Ordner „LearnHarness/“ und versteckte Ordner werden nicht eingelesen.
				Jede eingelesene Notiz kostet KI-Anfragen.
			</p>
		</>
	);
}
