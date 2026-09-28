import type { ModelConfig } from "./model-config";
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT } from "./review-prompt";
import type { Chunk, ChunkOutcome } from "./review-types";
import type { ActiveRule } from "./rules";
import { estimateTokens } from "./token-budget";

/** Retries per review step after the first attempt (D10). */
export const STEP_RETRIES = 2;

/** Neurons for one call, at the model config's prices. */
export function callNeurons(
  model: ModelConfig,
  inputTokens: number,
  outputTokens: number
): number {
  return (
    (inputTokens * model.neuronsPerMillionInputTokens +
      outputTokens * model.neuronsPerMillionOutputTokens) /
    1_000_000
  );
}

/** One call's worst case for a chunk: its whole prompt in, max_tokens out. */
export function chunkCallWorstCase(
  model: ModelConfig,
  chunk: Chunk,
  rules: readonly ActiveRule[]
): number {
  const input =
    estimateTokens(REVIEW_SYSTEM_PROMPT) +
    estimateTokens(buildReviewPrompt(chunk, rules, "0".repeat(16)));
  return callNeurons(model, input, model.maxOutputTokens);
}

/**
 * Reserved before a review starts (D12): input tokens plus max_tokens for
 * every chunk, once. Retries aren't reserved: with them, a review near the
 * 50 KB limit would need more than the whole day's budget.
 */
export function worstCaseNeurons(
  model: ModelConfig,
  chunks: readonly Chunk[],
  rules: readonly ActiveRule[]
): number {
  const total = chunks.reduce(
    (sum, chunk) => sum + chunkCallWorstCase(model, chunk, rules),
    0
  );
  return Math.ceil(total);
}

/**
 * What a review cost, to settle its reservation. A reviewed chunk costs its
 * last call's reported usage, plus its failed attempts at their worst case:
 * a failed attempt's usage is never reported, so it's charged in full. A
 * chunk that never got through is charged every attempt at its worst case.
 */
export function settledNeurons(
  model: ModelConfig,
  chunks: readonly Chunk[],
  rules: readonly ActiveRule[],
  outcomes: readonly ChunkOutcome[]
): number {
  const total = outcomes.reduce((sum, outcome, i) => {
    const worst = chunkCallWorstCase(model, chunks[i], rules);
    if (!outcome.reviewed) return sum + (1 + STEP_RETRIES) * worst;
    const { inputTokens, outputTokens } = outcome.usage;
    return (
      sum +
      callNeurons(model, inputTokens, outputTokens) +
      (outcome.attempt - 1) * worst
    );
  }, 0);
  return Math.ceil(total);
}
