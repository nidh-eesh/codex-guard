import type { ModelConfig } from "./model-config";
import { ruleLine } from "./review-prompt";
import {
  CUSTOM_RULE_ID_LENGTH,
  MAX_ACTIVE_RULES,
  RULE_TEXT_MAX_LENGTH,
  STARTER_PACK
} from "./rules";

/*
 * Reviewed module (AGENTS.md): the per-call token budget. Written by an
 * agent, reviewed by the author.
 */

export interface ChunkBudget {
  /**
   * Tokens left for a chunk once the context window holds the answer
   * (`maxOutputTokens`), the system prompt and the rules.
   */
  available: number;
  /**
   * The size chunks are packed to. Below `available`, to absorb estimation
   * error (D6).
   */
  target: number;
}

/** Code runs about 3 characters per token (D6). One estimator everywhere. */
const CHARS_PER_TOKEN = 3;

/**
 * Estimated tokens for text sent to the review model, rounded up. Chunk
 * sizes and the rules reserve are both measured with this, line-number
 * prefixes included (D13).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The review system prompt and the prompt's fixed text (section headings
 * and markers), about 430 tokens today; token-budget.test.ts checks it fits.
 */
export const SYSTEM_PROMPT_RESERVE = 1_000;

// The longest line a rule can take in the prompt: the longest ID, locked,
// the longer severity, and text at the limit (D5)
const LONGEST_RULE_LINE = ruleLine({
  id: "x".repeat(
    Math.max(
      CUSTOM_RULE_ID_LENGTH,
      ...STARTER_PACK.map((rule) => rule.id.length)
    )
  ),
  text: "x".repeat(RULE_TEXT_MAX_LENGTH),
  severity: "warning",
  locked: true,
  source: "starter"
});

/** Every active rule at the longest line: 50 × 81 = 4,050 tokens today. */
export const RULES_RESERVE =
  MAX_ACTIVE_RULES * estimateTokens(`${LONGEST_RULE_LINE}\n`);

/**
 * The chunk budget for one review call, computed from the model config
 * (DESIGN.md §6, "Token budget per call"): the context window holds the
 * answer, the system prompt, the rules and the chunk.
 */
export function chunkBudget(model: ModelConfig): ChunkBudget {
  const available =
    model.contextWindow -
    model.maxOutputTokens -
    SYSTEM_PROMPT_RESERVE -
    RULES_RESERVE;
  if (available <= 0) {
    throw new Error("The model's context window can't hold a review call.");
  }
  // Half the context window: 12,000 with the current model, well below the
  // 15,950 available. D6's bound, that any diff up to 18k tokens needs at
  // most 2 chunks, is 1.5 × this target: first-fit opens a third chunk only
  // once the pieces add up to more than 1.5 × target.
  const target = Math.min(Math.floor(model.contextWindow / 2), available);
  return { available, target };
}
