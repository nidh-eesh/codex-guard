import { describe, expect, it } from "vitest";
import { MODEL, type ModelConfig } from "./model-config";
import {
  buildReviewPrompt,
  newMarkerTag,
  REVIEW_SYSTEM_PROMPT
} from "./review-prompt";
import {
  MAX_ACTIVE_RULES,
  RULE_TEXT_MAX_LENGTH,
  type ActiveRule
} from "./rules";
import {
  chunkBudget,
  estimateTokens,
  RULES_RESERVE,
  SYSTEM_PROMPT_RESERVE
} from "./token-budget";

describe("estimateTokens", () => {
  it.each([
    ["", 0],
    ["a", 1],
    ["abc", 1],
    ["abcd", 2],
    ["x".repeat(3_000), 1_000],
    ["x".repeat(3_001), 1_001]
  ])(
    "estimates %j as %i tokens: 3 characters each, rounded up",
    (text, tokens) => {
      expect(estimateTokens(text)).toBe(tokens);
    }
  );

  it("counts characters, not bytes", () => {
    // "€" is 3 bytes in UTF-8 but one character
    expect(estimateTokens("€€€")).toBe(1);
  });

  it("counts newlines and line-number prefixes like any other characters", () => {
    expect(estimateTokens("12 | const a = 1;\n")).toBe(6);
  });
});

describe("chunkBudget", () => {
  const withModel = (fields: Partial<ModelConfig>): ModelConfig => ({
    ...MODEL,
    ...fields
  });

  it("leaves 15,950 tokens for a chunk with the current model (DESIGN.md §6)", () => {
    // 24k context - 3k answer - 1k system prompt - 50 rules × 81 tokens
    expect(RULES_RESERVE).toBe(4_050);
    expect(chunkBudget(MODEL).available).toBe(15_950);
  });

  it("packs chunks to 12k tokens with the current model (D6)", () => {
    expect(chunkBudget(MODEL).target).toBe(12_000);
  });

  it("targets less than it has available, to absorb estimation error", () => {
    const { available, target } = chunkBudget(MODEL);
    expect(target).toBeGreaterThan(0);
    expect(target).toBeLessThan(available);
  });

  it("gives a model with a larger context window a larger budget", () => {
    const big = chunkBudget(withModel({ contextWindow: 131_072 }));
    const current = chunkBudget(MODEL);
    expect(big.available).toBeGreaterThan(current.available);
    expect(big.target).toBeGreaterThan(current.target);
  });

  it("takes a larger answer out of the room for the chunk, token for token", () => {
    const current = chunkBudget(MODEL);
    const longer = chunkBudget(
      withModel({ maxOutputTokens: MODEL.maxOutputTokens + 1_000 })
    );
    expect(longer.available).toBe(current.available - 1_000);
    expect(longer.target).toBeLessThanOrEqual(longer.available);
  });

  it("reserves enough for the system prompt and 50 rules at the longest line", () => {
    // The worst case: 49 locked starter-style rules with the longest ID and
    // one custom rule, which adds the custom-rule markers
    const longest: ActiveRule = {
      id: "x".repeat(17),
      text: "x".repeat(RULE_TEXT_MAX_LENGTH),
      severity: "warning",
      locked: true,
      source: "starter"
    };
    const rules: ActiveRule[] = [
      ...Array.from({ length: MAX_ACTIVE_RULES - 1 }, () => longest),
      { ...longest, id: "c_12345678", locked: false, source: "custom" }
    ];
    const prompt = buildReviewPrompt(
      { text: "", files: [] },
      rules,
      newMarkerTag()
    );
    expect(
      estimateTokens(REVIEW_SYSTEM_PROMPT) + estimateTokens(prompt)
    ).toBeLessThanOrEqual(SYSTEM_PROMPT_RESERVE + RULES_RESERVE);
  });

  it("refuses a model whose context can't hold a review call", () => {
    expect(() =>
      chunkBudget(withModel({ contextWindow: 8_000, maxOutputTokens: 3_000 }))
    ).toThrow();
  });
});
