import { describe, expect, it } from "vitest";
import { resolveRules } from "./active-rules";
import { DAILY_REVIEW_NEURONS } from "./budget-ledger";
import { MODEL } from "./model-config";
import {
  callNeurons,
  chunkCallWorstCase,
  settledNeurons,
  STEP_RETRIES,
  worstCaseNeurons
} from "./review-cost";
import type { Chunk, ChunkOutcome } from "./review-types";
import {
  MAX_ACTIVE_RULES,
  RULE_TEXT_MAX_LENGTH,
  STARTER_PACK,
  type ActiveRule
} from "./rules";
import { chunkBudget } from "./token-budget";

const rules = resolveRules(STARTER_PACK, [], []).active;
const chunk = (chars: number): Chunk => ({
  text: "x".repeat(chars),
  files: [{ path: "a.ts", lines: [1] }]
});

const reviewed = (
  attempt: number,
  inputTokens = 1_000,
  outputTokens = 100
): ChunkOutcome => ({
  reviewed: true,
  attempt,
  atCap: false,
  usage: { inputTokens, outputTokens },
  findings: [],
  dropped: 0,
  droppedForErrorRules: 0
});

describe("callNeurons", () => {
  it("prices tokens from the model config", () => {
    expect(callNeurons(MODEL, 1_000_000, 0)).toBe(26_668);
    expect(callNeurons(MODEL, 0, 1_000_000)).toBe(204_805);
  });
});

describe("worstCaseNeurons", () => {
  it("is each chunk's whole prompt in and max_tokens out, once", () => {
    const chunks = [chunk(3_000), chunk(6_000)];
    const expected =
      chunkCallWorstCase(MODEL, chunks[0], rules) +
      chunkCallWorstCase(MODEL, chunks[1], rules);
    expect(worstCaseNeurons(MODEL, chunks, rules)).toBe(Math.ceil(expected));
  });

  it("charges max_tokens for the answer, whatever the answer turns out to be", () => {
    expect(chunkCallWorstCase(MODEL, chunk(0), rules)).toBeGreaterThan(
      callNeurons(MODEL, 0, MODEL.maxOutputTokens)
    );
  });

  it("is nothing for a review with no chunks (every file skipped)", () => {
    expect(worstCaseNeurons(MODEL, [], rules)).toBe(0);
  });

  it("fits the largest review, three chunks at the full target, in the daily budget (D6, D12)", () => {
    // 50 rules at the longest line, as in the rules reserve (D5)
    const longest: ActiveRule = {
      id: "x".repeat(17),
      text: "x".repeat(RULE_TEXT_MAX_LENGTH),
      severity: "warning",
      locked: true,
      source: "starter"
    };
    const mostRules = Array.from({ length: MAX_ACTIVE_RULES }, () => longest);
    const full = chunk(chunkBudget(MODEL).target * 3);
    expect(
      worstCaseNeurons(MODEL, [full, full, full], mostRules)
    ).toBeLessThanOrEqual(DAILY_REVIEW_NEURONS);
  });
});

describe("settledNeurons", () => {
  const chunks = [chunk(3_000), chunk(3_000)];
  const worst = chunkCallWorstCase(MODEL, chunks[0], rules);

  it("charges a first-try chunk its reported usage only", () => {
    expect(settledNeurons(MODEL, [chunks[0]], rules, [reviewed(1)])).toBe(
      Math.ceil(callNeurons(MODEL, 1_000, 100))
    );
  });

  it("charges each failed attempt before a success at its worst case", () => {
    expect(settledNeurons(MODEL, [chunks[0]], rules, [reviewed(3)])).toBe(
      Math.ceil(callNeurons(MODEL, 1_000, 100) + 2 * worst)
    );
  });

  it("charges a chunk that never got through every attempt at its worst case", () => {
    expect(
      settledNeurons(MODEL, [chunks[0]], rules, [{ reviewed: false }])
    ).toBe(Math.ceil((1 + STEP_RETRIES) * worst));
  });

  it("adds up across chunks", () => {
    expect(
      settledNeurons(MODEL, chunks, rules, [reviewed(1), { reviewed: false }])
    ).toBe(Math.ceil(callNeurons(MODEL, 1_000, 100) + 3 * worst));
  });

  it("is nothing for a review with no chunks", () => {
    expect(settledNeurons(MODEL, [], rules, [])).toBe(0);
  });
});
