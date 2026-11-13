/**
 * IO half of src/core/subject-exam-plan.ts (fork addition, 2026-11-11):
 * exam plans in Auftraege/ that name a subject (`fach: IntSec`) get the
 * subject's new topics appended after a review. The exam-plan sync that
 * runs next turns each new section into its own session.
 */
import fs from "node:fs";
import path from "node:path";
import { EXAM_PLANS_DIR } from "../core/exam-plan.ts";
import { appendNewTopics, planSubject } from "../core/subject-exam-plan.ts";
import { scanExamPlans } from "./exam-plans.ts";
import { subjectResult } from "./subject-review.ts";

export interface PlanExtension {
	file: string;
	added: string[];
	skipped: string[];
}

export function extendExamPlansFromSubjects(root: string): PlanExtension[] {
	const out: PlanExtension[] = [];
	for (const file of scanExamPlans(root)) {
		const full = path.join(root, ...EXAM_PLANS_DIR.split("/"), file);
		let text: string;
		try {
			text = fs.readFileSync(full, "utf-8");
		} catch {
			continue;
		}
		const subject = planSubject(text);
		const result = subject ? subjectResult(subject) : null;
		if (!result) continue;
		const r = appendNewTopics(text, result.topics);
		if (r.added.length) {
			const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
			fs.writeFileSync(tmp, r.text, "utf-8");
			fs.renameSync(tmp, full);
			console.log(`[faecher] ${file}: ${r.added.length} new topic(s) appended`);
		}
		if (r.skipped.length) console.warn(`[faecher] ${file}: ${r.skipped.length} topic(s) not appended, plan is full`);
		if (r.added.length || r.skipped.length) out.push({ file, added: r.added, skipped: r.skipped });
	}
	return out;
}
