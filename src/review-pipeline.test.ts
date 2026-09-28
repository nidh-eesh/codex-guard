import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runReview, type RunStep } from "./review-pipeline";
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

const DIFF = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+console.log(1);\n";

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
    return work();
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
      name.startsWith("review chunk") ? Promise.reject(new Error("x")) : work();
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
});
