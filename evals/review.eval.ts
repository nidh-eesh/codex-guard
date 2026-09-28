import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRules } from "../src/active-rules";
import { runReview } from "../src/review-pipeline";
import type { Verdict } from "../src/review-types";
import { STARTER_PACK } from "../src/rules";
import { connectReviewModel, retryingStep } from "./workers-ai";

/*
 * The demo diffs, reviewed by the real review model with the starter pack.
 * Rerun after any change to the review prompt, the model or the pipeline:
 * npm run eval
 */

const DIR = "fixtures/reviews";

interface EvalCase {
  file: string;
  verdict: Verdict;
  /** Rule IDs that must be among the findings. */
  mustFind?: string[];
}

const cases = JSON.parse(
  readFileSync(join(DIR, "cases.json"), "utf8")
) as EvalCase[];

// The fixtures hold placeholders, so no key-shaped string is committed for
// gitleaks to flag. The fake key is assembled here at run time.
const FAKE_KEYS: Record<string, string> = {
  "{{FAKE_AWS_KEY}}": "AKIA" + "Q7ZJ3LX2EXAMPLE1"
};

function loadDiff(file: string): string {
  let diff = readFileSync(join(DIR, file), "utf8");
  for (const [placeholder, key] of Object.entries(FAKE_KEYS)) {
    diff = diff.replaceAll(placeholder, key);
  }
  return diff;
}

const rules = resolveRules(STARTER_PACK, [], []).active;

describe("review evals", () => {
  let model: LanguageModel;
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(async () => ({ model, dispose } = await connectReviewModel()));
  afterAll(() => dispose?.());

  it.each(cases)(
    "$file: $verdict",
    async ({ file, verdict, mustFind = [] }) => {
      const result = await runReview(
        loadDiff(file),
        rules,
        model,
        retryingStep
      );
      console.log(
        [
          `${file}: ${result.verdict}`,
          ...result.notes.map((note) => `  note: ${note}`),
          ...result.findings.map(
            (f) =>
              `  ${f.severity} ${f.ruleId} ${f.file}:${f.line}: ${f.message}`
          )
        ].join("\n")
      );
      expect(result.verdict).toBe(verdict);
      const found = result.findings.map((f) => f.ruleId);
      for (const ruleId of mustFind) expect(found).toContain(ruleId);
    }
  );
});
