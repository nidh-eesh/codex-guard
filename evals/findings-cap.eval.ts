import { generateText, jsonSchema, Output, type LanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRules } from "../src/active-rules";
import { MODEL } from "../src/model-config";
import {
  buildReviewPrompt,
  MAX_FINDINGS_PER_CHUNK,
  newMarkerTag,
  REVIEW_RESPONSE_SCHEMA,
  REVIEW_SYSTEM_PROMPT
} from "../src/review-prompt";
import { STARTER_PACK } from "../src/rules";
import { connectReviewModel } from "./workers-ai";

/*
 * Measures output tokens per finding, to size MAX_FINDINGS_PER_CHUNK against
 * max_tokens (D21). A diff adds 40 console.log lines, each a warning.
 * Rerun after changing the review prompt or model: npm run eval:findings-cap
 */

const LINES = 40;
const diff = [
  "diff --git a/src/pipeline.ts b/src/pipeline.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/pipeline.ts",
  `@@ -0,0 +1,${LINES + 2} @@`,
  "+export function runPipeline(items: string[]) {",
  ...Array.from(
    { length: LINES },
    (_, i) => `+  console.log("pipeline step ${i + 1}:", items.length);`
  ),
  "+}"
].join("\n");

const rules = resolveRules(STARTER_PACK, [], []).active;
const acceptAnyJson = jsonSchema(REVIEW_RESPONSE_SCHEMA, {
  validate: (value) => ({ success: true, value })
});

async function measure(model: LanguageModel, cap: number) {
  const system = REVIEW_SYSTEM_PROMPT.replace(
    `At most ${MAX_FINDINGS_PER_CHUNK} findings`,
    `At most ${cap} findings`
  );
  expect(system).toContain(`At most ${cap} findings`);
  const result = await generateText({
    model,
    system,
    prompt: buildReviewPrompt({ text: diff, files: [] }, rules, newMarkerTag()),
    maxOutputTokens: MODEL.maxOutputTokens,
    maxRetries: 0,
    output: Output.object({ schema: acceptAnyJson })
  });
  const outputTokens = result.usage.outputTokens ?? 0;
  let findings: unknown[] = [];
  try {
    findings = (JSON.parse(result.text) as { findings: unknown[] }).findings;
  } catch {
    // Cut off or not JSON: findings stay empty
  }
  const tokensPerChar = outputTokens / Math.max(result.text.length, 1);
  const findingTokens = findings.map(
    (f) => JSON.stringify(f).length * tokensPerChar
  );
  return {
    cap,
    finishReason: result.finishReason,
    findings: findings.length,
    outputTokens,
    perFindingAverage: findings.length
      ? Math.round(outputTokens / findings.length)
      : null,
    perFindingMaxEstimate: findingTokens.length
      ? Math.round(Math.max(...findingTokens))
      : null
  };
}

describe(`findings cap: ${LINES} console.log lines, max_tokens ${MODEL.maxOutputTokens}`, () => {
  let model: LanguageModel;
  let dispose: (() => Promise<void>) | undefined;
  beforeAll(async () => ({ model, dispose } = await connectReviewModel()));
  afterAll(() => dispose?.());

  it.each([
    ["current cap, run 1", MAX_FINDINGS_PER_CHUNK],
    ["current cap, run 2", MAX_FINDINGS_PER_CHUNK],
    ["no practical cap", 100]
  ])("%s", async (_label, cap) => {
    const row = await measure(model, cap);
    console.log(JSON.stringify(row));
  });
});
