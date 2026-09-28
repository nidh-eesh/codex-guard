import { readFileSync } from "node:fs";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { splitDiff } from "./diff-split";
import { MODEL } from "./model-config";
import { callNeurons, chunkCallWorstCase } from "./review-cost";
import { runReview, type RunStep } from "./review-pipeline";
import { chunkBudget } from "./token-budget";
import { MAX_FINDINGS_PER_CHUNK } from "./review-prompt";
import type { ActiveRule } from "./rules";

const RULES: ActiveRule[] = [
  {
    id: "no-secrets",
    text: "No secrets or API keys in code",
    severity: "error",
    locked: true,
    source: "starter"
  },
  {
    id: "no-console-log",
    text: "No `console.log` left in production code",
    severity: "warning",
    locked: false,
    source: "starter"
  }
];

// A new file of 30 lines, so findings can point at lines 1-30
const DIFF = `${[
  "diff --git a/a.ts b/a.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/a.ts",
  "@@ -0,0 +1,30 @@",
  ...Array.from({ length: 30 }, (_, i) => `+console.log(${i + 1});`)
].join("\n")}\n`;

const warning = (line: number) => ({
  ruleId: "no-console-log",
  file: "a.ts",
  line,
  message: "A console.log.",
  suggestion: "Remove it."
});

function answering(findings: unknown[]) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ findings }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: {
          total: 1000,
          noCache: 1000,
          cacheRead: undefined,
          cacheWrite: undefined
        },
        outputTokens: { total: 100, text: 100, reasoning: undefined }
      },
      warnings: []
    })
  });
}

/** Runs each step once, in memory, recording its name. */
function steps() {
  const names: string[] = [];
  const run: RunStep = (name, work) => {
    names.push(name);
    return work(1);
  };
  return { run, names };
}

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => warning(i + 1));

describe("runReview", () => {
  it("names its steps split, review chunk N, combine", async () => {
    const { run, names } = steps();
    await runReview(DIFF, RULES, answering([]), run);
    expect(names).toEqual(["split", "review chunk 1", "combine"]);
  });

  it("passes when the answer stays under the findings cap", async () => {
    const result = await runReview(
      DIFF,
      RULES,
      answering(lines(MAX_FINDINGS_PER_CHUNK - 1)),
      steps().run
    );
    expect(result.verdict).toBe("pass");
  });

  it("is incomplete when the answer reaches the cap with only warnings", async () => {
    const result = await runReview(
      DIFF,
      RULES,
      answering(lines(MAX_FINDINGS_PER_CHUNK)),
      steps().run
    );
    expect(result.verdict).toBe("incomplete");
  });

  it("keeps every valid finding past the cap", async () => {
    const result = await runReview(
      DIFF,
      RULES,
      answering(lines(MAX_FINDINGS_PER_CHUNK + 3)),
      steps().run
    );
    expect(result.findings).toHaveLength(MAX_FINDINGS_PER_CHUNK + 3);
  });

  it("counts invalid findings toward the cap", async () => {
    const answer = [...lines(MAX_FINDINGS_PER_CHUNK - 1), { ruleId: 42 }];
    const result = await runReview(DIFF, RULES, answering(answer), steps().run);
    expect(result.verdict).toBe("incomplete");
  });

  it("records a chunk whose step keeps failing as not reviewed", async () => {
    const failing: RunStep = (name, work) =>
      name.startsWith("review chunk")
        ? Promise.reject(new Error("x"))
        : work(1);
    const result = await runReview(DIFF, RULES, answering([]), failing);
    expect(result).toMatchObject({
      verdict: "incomplete",
      chunks: { total: 1, failed: 1 }
    });
  });

  it("redacts keys in the findings it returns", async () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const result = await runReview(
      DIFF,
      RULES,
      answering([
        { ...warning(1), ruleId: "no-secrets", message: `Key ${key} found.` }
      ]),
      steps().run
    );
    expect(result.findings[0].message).toBe("Key [REDACTED] found.");
  });

  it("doesn't pass code hidden in files skipped as minified or generated (D22)", async () => {
    // A padded first line (over 1,000 characters) and a *.min.ts name: both
    // files are skipped, and both hide an SQL injection
    const diff = readFileSync(
      new URL("../fixtures/reviews/minified-bypass.diff", import.meta.url),
      "utf8"
    );
    const model = answering([]);
    const result = await runReview(diff, RULES, model, steps().run);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(result.verdict).toBe("incomplete");
    expect(result.notes).toEqual([
      "Review incomplete: `src/db/find-user.ts` was skipped as minified or generated and could hide code that breaks the rules.",
      "Review incomplete: `src/db/find-order.min.ts` was skipped as minified or generated and could hide code that breaks the rules.",
      "Nothing to review: every file in the diff was skipped."
    ]);
    // Nothing was sent to the model, so there's nothing to charge
    expect(result.neurons).toBe(0);
  });
});

describe("runReview cost, to settle the reservation (D12)", () => {
  const [chunk] = splitDiff(DIFF, chunkBudget(MODEL)).chunks;
  const worst = chunkCallWorstCase(MODEL, chunk, RULES);
  const reported = callNeurons(MODEL, 1_000, 100);

  it("is the reported usage when the chunk succeeds first time", async () => {
    const result = await runReview(DIFF, RULES, answering([]), steps().run);
    expect(result.neurons).toBe(Math.ceil(reported));
  });

  it("adds each failed attempt before the success at its worst case", async () => {
    const onThirdAttempt: RunStep = (name, work) =>
      work(name.startsWith("review chunk") ? 3 : 1);
    const result = await runReview(DIFF, RULES, answering([]), onThirdAttempt);
    expect(result.neurons).toBe(Math.ceil(reported + 2 * worst));
  });

  it("charges a chunk that never got through all its attempts", async () => {
    const failing: RunStep = (name, work) =>
      name.startsWith("review chunk")
        ? Promise.reject(new Error("x"))
        : work(1);
    const result = await runReview(DIFF, RULES, answering([]), failing);
    expect(result.neurons).toBe(Math.ceil(3 * worst));
  });
});
