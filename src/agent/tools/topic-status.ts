import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { topicStatusText, type TopicStatus } from "../../core/topic-status.ts";

/**
 * topic_status (fork addition, Paul 2026-11-09) — SERVER-SIDE, read-only:
 * the live numbers of the exam topic this session belongs to. Registered
 * only in exam topic chats (the composition root injects the reader).
 * Rules: src/core/topic-status.ts. Mechanics only.
 */

const topicStatusInput = Type.Object({});

export function topicStatusTool(read: () => TopicStatus | null): AgentTool<typeof topicStatusInput> {
	return {
		name: "topic_status",
		label: "topic_status",
		description:
			"Read this session's exam topic status as LearnHarness counts it: worked through, understood (and its target), done, " +
			"open questions, whether the topic is finished, and what is missing. Read-only; no arguments.",
		parameters: topicStatusInput,
		execute: serverExecute("topic_status", topicStatusInput, async () => topicStatusText(read())),
	};
}
