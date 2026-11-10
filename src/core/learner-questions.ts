/**
 * His questions come first (fork addition, Paul 2026-11-10) — PURE.
 *
 * Why: the tutor often posed the next quiz with no text at all, even when
 * Paul's thinking field carried a question ("it just stops talking"). The
 * prompts tell it to READ the thinking fields as evidence of his
 * understanding; nothing told it to ANSWER what he asks there. This note
 * (stable text, appended to the teach/probe system prompt — the prompt
 * cache stays warm) does. With nothing asked, a silent next question
 * stays fine: the pace is his choice too.
 */
export const LEARNER_QUESTIONS_NOTE = [
	"## His questions come first",
	"When his message or any thinking field he sends (`thinking`, `thinkingWhileReading` — often dictated speech) contains a " +
		"question, a doubt, or a request to explain something, answer it completely in text BEFORE you pose the next question or " +
		"move on: every question he asked, none skipped, at the depth it needs — no matter whether his quiz answer was right. " +
		"If he asked nothing, you may go straight to the next question.",
].join("\n");
