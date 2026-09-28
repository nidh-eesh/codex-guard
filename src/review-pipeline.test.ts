import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runReview, type RunStep } from "./review-pipeline";
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

describe("runReview", () => {
  it("names its steps split, review chunk N, combine", async () => {
    const { run, names } = steps();
    await runReview(DIFF, RULES, answering([]), run);
    expect(names).toEqual(["split", "review chunk 1", "combine"]);
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
