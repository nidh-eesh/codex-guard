import type { LanguageModelUsage, UIMessage } from "ai";
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
