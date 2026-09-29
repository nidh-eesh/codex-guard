import {
  stepCountIs,
  type LanguageModelMiddleware,
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepFunction,
  type StopCondition,
  type ToolSet,
  type UIMessage
} from "ai";
import type { ModelConfig } from "./model-config";
import { callNeurons } from "./review-cost";
import { stripReviewDetails } from "./review-summary";

/** How many of the latest messages the chat model sees each turn (D26). */
export const CHAT_HISTORY_MESSAGES = 10;

/**
 * The history sent to the chat model: the latest CHAT_HISTORY_MESSAGES
 * messages, each review reduced to its summary (D9). A tool call and its
 * result are parts of one message, so the cut never separates them.
 */
export function chatHistory(messages: readonly UIMessage[]): UIMessage[] {
  return stripReviewDetails(messages.slice(-CHAT_HISTORY_MESSAGES));
}

/**
 * What a chat turn cost, from the usage the model reported for each step
 * (D26). A count the model didn't report is charged as 0, as for reviews.
 */
export function chatTurnNeurons(
  model: ModelConfig,
  steps: readonly { usage: LanguageModelUsage }[]
): number {
  return steps.reduce(
    (sum, { usage }) =>
      sum + callNeurons(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0),
    0
  );
}

/** Most steps in one chat turn: room for a tool call and the answer after it. */
export const MAX_CHAT_STEPS = 5;

/** When a chat turn stops: at the step limit (D28 adds no other). */
export function chatStopWhen<TOOLS extends ToolSet>(): StopCondition<TOOLS> {
  return stepCountIs(MAX_CHAT_STEPS);
}

// Tool results that mean the call didn't happen: it failed (a refused rule
// change) or a person rejected it
const REFUSED_OUTPUTS = new Set([
  "error-text",
  "error-json",
  "execution-denied"
]);

/**
 * Whether the latest tool results include a refused or rejected call. They
 * are the last input message both after a step in this turn and, at the
 * first step after an approval, for the approved calls that just ran.
 */
export function lastCallRefused(messages: readonly ModelMessage[]): boolean {
  const last = messages.at(-1);
  return (
    last?.role === "tool" &&
    last.content.some(
      (part) =>
        part.type === "tool-result" && REFUSED_OUTPUTS.has(part.output.type)
    )
  );
}

/**
 * After a refused or rejected call, the next step runs with no tools: the
 * model has to explain in words and can't retry it (D28).
 */
export function explainAfterRefusal<
  TOOLS extends ToolSet
>(): PrepareStepFunction<TOOLS> {
  return ({ messages }) =>
    lastCallRefused(messages) ? { activeTools: [] } : undefined;
}

/**
 * A step with no active tools sends `tools: []`, which Workers AI rejects
 * ("`tools` must not be an empty array"). This leaves the field out instead,
 * so the step after a refusal can run.
 */
export const omitEmptyTools: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) =>
    params.tools?.length === 0
      ? { ...params, tools: undefined, toolChoice: undefined }
      : params
};
