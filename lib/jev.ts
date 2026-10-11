// lib/jev.ts
// The one place that calls Jev (TypeSafe's typed-question model) through
// AI Gateway. `experimental_evaluate` is an experimental AI SDK call and the
// gateway model ID is unversioned, so keeping the call here limits what an SDK
// upgrade or a model release can break.

import {
  experimental_evaluate as evaluate,
  gateway,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";

/** Unversioned on AI Gateway: the answering version can change without notice. */
export const JEV_MODEL_ID = "typesafe-ai/jev";

export type JevQuestion = EvaluationQuestion;

export type JevAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number };

export type JevState = Record<string, string | null>;

export type JevEvaluateFn = (args: {
  state: JevState;
  questions: Record<string, JevQuestion>;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}) => Promise<{
  answers: Record<string, JevAnswer>;
  inputTokens: number | null;
}>;

export const evaluateWithJev: JevEvaluateFn = async ({
  state,
  questions,
  abortSignal,
  maxRetries,
}) => {
  const result = await evaluate({
    model: gateway.evaluationModel(JEV_MODEL_ID),
    state,
    questions,
    maxRetries: maxRetries ?? 1,
    abortSignal,
  });
  return {
    answers: result.answers as Record<string, JevAnswer>,
    inputTokens: result.usage.inputTokens ?? null,
  };
};

/** P(yes) for a yes/no question, clamped to [0, 1]. Throws when it is missing. */
export function booleanProbability(
  answers: Record<string, JevAnswer>,
  id: string,
): number {
  const answer = answers[id];
  if (answer?.type !== "boolean" || !Number.isFinite(answer.probability)) {
    throw new Error(`jev_missing_answer:${id}`);
  }
  return Math.min(1, Math.max(0, answer.probability));
}

/** The provider rejects a whole call when a pick-one question ties. */
export function isChoiceTieError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /did not select a highest-probability option/i.test(error.message)
  );
}
