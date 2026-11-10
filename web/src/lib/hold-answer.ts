import type { DialogHold } from '$shared/types/ws-messages.js';

export type HoldQuestion = Extract<DialogHold, { kind: 'question' }>['questions'][number];

/** What a question card sends: an answer per question, and the notes added to a picked option. */
export interface ComposedAnswers {
	answers: Record<string, string>;
	annotations: Record<string, { notes: string }>;
}

/**
 * The card's state as Claude Code takes an answer. The picked options are the
 * answer (`Red, Blue` for several). Words typed beside a pick are a note on it,
 * which Claude Code reads from `annotations` and shows Claude as
 * `"Which?"="Red" notes: …`; typed with nothing picked, they are the answer.
 * A question with neither is left out, so the card can tell it is unanswered.
 */
export function composeAnswers(
	questions: readonly HoldQuestion[],
	picks: Record<string, readonly string[] | undefined>,
	typed: Record<string, string | undefined>
): ComposedAnswers {
	const answers: Record<string, string> = {};
	const annotations: Record<string, { notes: string }> = {};
	for (const { question } of questions) {
		const picked = picks[question] ?? [];
		const own = typed[question]?.trim() ?? '';
		if (picked.length > 0) {
			answers[question] = picked.join(', ');
			if (own) annotations[question] = { notes: own };
		} else if (own) {
			answers[question] = own;
		}
	}
	return { answers, annotations };
}
