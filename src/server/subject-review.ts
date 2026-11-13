/**
 * Fach-Überprüfung (fork addition) — the IO half of src/core/subject-review.ts.
 *
 * At app start (after the inbox import and exam plans), every subject folder
 * `<brain>/LearnHarness/Faecher/<Fach>/` whose materials changed since its
 * last review gets ONE review run on the strong (teacher) engine:
 *   - PDFs are turned into text once (cached by content hash in the data
 *     folder, so a run never pays for the same conversion twice);
 *   - the run reads all materials, the current plan.md (Paul's edits
 *     included) and his learning record in the subject;
 *   - it writes plan.md and puts its changes on top of aenderungen.md.
 * A failed run is recorded and retried at the next start; other subjects
 * still run. Bookkeeping lives in faecher.json in the data folder.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { digestSession } from "../core/brain-export.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import { EXAM_PLANS_DIR, examFolderName } from "../core/exam-plan.ts";
import { topFolderName } from "../core/study-timer.ts";
import {
	CHANGES_FILE,
	META_FILE,
	PAST_EXAMS_DIR,
	PLAN_FILE,
	REVIEW_SCHEMA,
	REVIEW_SYSTEM_PROMPT,
	SLIDES_DIR,
	SUBJECTS_DIR,
	buildReviewPrompt,
	fillReview,
	parseSubjectMeta,
	previousTopicTitles,
	renderChanges,
	renderPlan,
	validateReview,
	lecturePlanFile,
	renderLecturePlan,
	type LearnerSession,
	type Material,
	type ReviewInput,
	type ReviewResult,
} from "../core/subject-review.ts";
import { ModelsNotConfiguredError } from "../core/settings.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { engineForRole } from "./chat-handler.ts";
import { stores } from "./stores.ts";

export const SUBJECT_STATE_FILE = path.join(PATHS.data, "faecher.json");
const PDF_CACHE_DIR = path.join(PATHS.data, "faecher-cache");
const MATERIAL_EXT = /\.(pdf|md|markdown|txt)$/i;
const MAX_PDF_PAGES = 400;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Most recent sessions of the subject that go into the prompt. */
const MAX_LEARNER_SESSIONS = 40;
/** Turns a run may take (schema/law retries). */
const REVIEW_MAX_TURNS = 6;

interface SubjectState {
	fingerprint: string;
	reviewedAt?: string;
	run: number;
	materials: string[];
	lastError?: string;
	lastAttemptAt?: string;
	result?: ReviewResult;
}
interface StateFile {
	version: 1;
	subjects: Record<string, SubjectState>;
}

function readState(): StateFile {
	try {
		const raw = JSON.parse(fs.readFileSync(SUBJECT_STATE_FILE, "utf-8")) as Partial<StateFile>;
		if (raw?.version === 1 && raw.subjects && typeof raw.subjects === "object") return { version: 1, subjects: { ...raw.subjects } };
	} catch { /* first run */ }
	return { version: 1, subjects: {} };
}

/** The latest review result of a subject, or null (fork: exam plans that
 *  opted in with `fach:` read their topics from here). */
export function subjectResult(subject: string): ReviewResult | null {
	return readState().subjects[subject]?.result ?? null;
}

function writeAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, content, "utf-8");
	fs.renameSync(tmp, file);
}

const sha256 = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const subjectsRoot = (root: string) => path.join(root, ...SUBJECTS_DIR.split("/"));

/** Subject folders (names) under LearnHarness/Faecher/. Exported for tests. */
export function listSubjects(root: string): string[] {
	try {
		return fs.readdirSync(subjectsRoot(root), { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

interface MaterialFile {
	kind: Material["kind"];
	name: string;
	abs: string;
	hash: string;
}

function materialFiles(dir: string): MaterialFile[] {
	const out: MaterialFile[] = [];
	for (const [kind, sub] of [["slides", SLIDES_DIR], ["exam", PAST_EXAMS_DIR]] as const) {
		const walk = (abs: string, rel: string) => {
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
			for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
				if (e.name.startsWith(".")) continue;
				const childAbs = path.join(abs, e.name);
				const childRel = `${rel}/${e.name}`;
				if (e.isDirectory()) walk(childAbs, childRel);
				else if (e.isFile() && MATERIAL_EXT.test(e.name)) {
					try {
						if (fs.statSync(childAbs).size > MAX_FILE_BYTES) continue;
						out.push({ kind, name: childRel, abs: childAbs, hash: sha256(fs.readFileSync(childAbs)) });
					} catch { /* unreadable: skipped, picked up once readable */ }
				}
			}
		};
		walk(path.join(dir, sub), sub);
	}
	return out;
}

/** Text of one material; PDFs are converted once and cached by hash. */
async function materialText(f: MaterialFile): Promise<string> {
	if (!/\.pdf$/i.test(f.name)) return fs.readFileSync(f.abs, "utf-8");
	const cached = path.join(PDF_CACHE_DIR, `${f.hash}.md`);
	try { return fs.readFileSync(cached, "utf-8"); } catch { /* convert */ }
	const pdf = await convertPdf(new Uint8Array(fs.readFileSync(f.abs)), MAX_PDF_PAGES);
	let text: string;
	if (pdf.kind === "converted") {
		const joined = joinPages(pdf.pages);
		text = joined || "[This PDF has no extractable text (scanned images only).]";
	} else {
		text = pdf.kind === "too-long" ? `[PDF over ${MAX_PDF_PAGES} pages — not read.]` : "[PDF could not be opened.]";
	}
	writeAtomic(cached, text);
	return text;
}

function readOptional(file: string): string | null {
	try { return fs.readFileSync(file, "utf-8"); } catch { return null; }
}

/** Paul's sessions in this subject: chats in a folder named like the
 *  subject (or its exam folder "<Fach> Klausur"), newest first. */
function learnerSessions(subject: string, examName: string | null): LearnerSession[] {
	const organization = stores.sourceOrganizationStore.read();
	const names = new Set([subject, examFolderName({ exam: subject }), ...(examName ? [examName, examFolderName({ exam: examName })] : [])].map((n) => n.toLowerCase()));
	const records: ChatRecord[] = [];
	for (const summary of stores.chatStore.listChats()) {
		const top = topFolderName(organization, summary.id);
		if (!top || !names.has(top.toLowerCase())) continue;
		const record = stores.chatStore.getChat(summary.id);
		if (record) records.push(record);
	}
	return records
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, MAX_LEARNER_SESSIONS)
		.map((r) => {
			const d = digestSession(r);
			return {
				title: r.title,
				minutes: Math.round(d.learningMs / 60_000),
				questions: d.questions,
				graded: d.graded,
				correct: d.correct,
				unsure: d.unsure.map((u) => u.question),
				lastActive: r.updatedAt.slice(0, 10),
			};
		});
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export type Reviewer = (input: ReviewInput, previousTitles: string[]) => Promise<ReviewResult>;

const slideNames = (materials: readonly Pick<Material, "kind" | "name">[]) => materials.filter((m) => m.kind === "slides").map((m) => m.name);

/** Bumped when a run must cover more than before: every subject is then
 *  reviewed once more even with unchanged materials. 2 = per-lecture
 *  analysis for the lecture sessions (Paul, 2026-11-12). */
const REVIEW_VERSION = 2;

/** The real run: one submit agent on the strong engine. */
export const modelReviewer: Reviewer = (input, previousTitles) => {
	const engine = engineForRole("teacher");
	if (!engine) throw new ModelsNotConfiguredError(["strong"]);
	return runSubmitAgent<ReviewResult>({
		role: "teacher",
		toolName: "submit_plan",
		toolDescription: "Submit the complete updated study plan for the subject.",
		parameters: REVIEW_SCHEMA,
		fill: fillReview,
		validate: (r) => validateReview(r, previousTitles, slideNames(input.materials)),
		systemPrompt: REVIEW_SYSTEM_PROMPT,
		prompt: buildReviewPrompt(input),
		engine,
		signal: undefined,
		maxTurns: REVIEW_MAX_TURNS,
		onStep: (usage, model, step) => console.log(`[faecher] ${input.subject} step ${step} on ${model}: ${usage.input} in / ${usage.output} out`),
		neverSubmitted: "The review run ended without submitting a plan.",
	});
};

export interface SubjectReviewOutcome {
	subject: string;
	status: "reviewed" | "unchanged" | "empty" | "failed";
	topics?: number;
	/** Lectures in the written lecture plan (one session each). */
	lectures?: number;
	newMaterials?: string[];
	error?: string;
}

/** Review every subject whose materials changed. Exported for tests (inject
 *  a reviewer); the app passes the model reviewer. */
export async function reviewSubjects(
	root: string,
	opts: { reviewer?: Reviewer; now?: Date; onSubject?: (subject: string) => void } = {},
): Promise<SubjectReviewOutcome[]> {
	const reviewer = opts.reviewer ?? modelReviewer;
	const now = opts.now ?? new Date();
	const state = readState();
	const outcomes: SubjectReviewOutcome[] = [];
	for (const subject of listSubjects(root)) {
		const dir = path.join(subjectsRoot(root), subject);
		const files = materialFiles(dir);
		if (files.length === 0) {
			outcomes.push({ subject, status: "empty" });
			continue;
		}
		const metaText = readOptional(path.join(dir, META_FILE));
		const fingerprint = sha256([`review|v${REVIEW_VERSION}`, ...files.map((f) => `${f.kind}|${f.name}|${f.hash}`), `meta|${sha256(metaText ?? "")}`].join("\n"));
		const prev = state.subjects[subject];
		const planPath = path.join(dir, PLAN_FILE);
		const previousPlan = readOptional(planPath);
		if (prev?.fingerprint === fingerprint && !prev.lastError && previousPlan !== null) {
			outcomes.push({ subject, status: "unchanged", topics: previousTopicTitles(previousPlan).length });
			continue;
		}
		opts.onSubject?.(subject);
		const known = new Set(prev?.materials ?? []);
		const newMaterials = files.map((f) => f.name).filter((n) => !known.has(n));
		try {
			const meta = parseSubjectMeta(metaText);
			const materials: Material[] = [];
			for (const f of files) materials.push({ kind: f.kind, name: f.name, text: await materialText(f) });
			const previousTitles = previousTopicTitles(previousPlan);
			const input: ReviewInput = { subject, meta, materials, previousPlan, learner: learnerSessions(subject, meta.exam), today: localDay(now) };
			const result = await reviewer(input, previousTitles);
			// The laws hold for injected reviewers too.
			const problem = validateReview(result, previousTitles, slideNames(files));
			if (problem) throw new Error(`Review broke a plan rule: ${problem}`);
			const at = now.toISOString();
			const run = (prev?.run ?? 0) + 1;
			writeAtomic(planPath, renderPlan(subject, meta, result, at, run));
			const changesPath = path.join(dir, CHANGES_FILE);
			writeAtomic(changesPath, renderChanges(readOptional(changesPath), subject, result, at, newMaterials));
			// One learning session per lecture: the analysis becomes a
			// Klausur-Auftrag; syncExamPlans turns it into sessions.
			if (result.lectures.length) {
				const plan = renderLecturePlan(subject, meta, result.lectures, {
					slidePath: (file) => path.join(dir, file),
					examsDir: path.join(dir, PAST_EXAMS_DIR),
				}, at);
				writeAtomic(path.join(root, EXAM_PLANS_DIR, lecturePlanFile(subject)), plan);
			}
			state.subjects[subject] = { fingerprint, reviewedAt: at, run, materials: files.map((f) => f.name), result };
			outcomes.push({ subject, status: "reviewed", topics: result.topics.filter((t) => t.status === "active").length, lectures: result.lectures.length, newMaterials });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			state.subjects[subject] = { ...(prev ?? { fingerprint: "", run: 0, materials: [] }), lastError: error, lastAttemptAt: now.toISOString() };
			outcomes.push({ subject, status: "failed", error });
			console.error(`[faecher] review of ${subject} failed:`, error);
			// Without models nothing else can run either.
			if (err instanceof ModelsNotConfiguredError) break;
		} finally {
			writeAtomic(SUBJECT_STATE_FILE, `${JSON.stringify(state, null, "\t")}\n`);
		}
	}
	return outcomes;
}
