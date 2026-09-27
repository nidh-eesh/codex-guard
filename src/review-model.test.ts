import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { MODEL } from "./model-config";
import { MalformedReviewError, reviewChunk } from "./review-model";
import type { ActiveRule } from "./rules";

const RULES: ActiveRule[] = [
  {
    id: "no-secrets",
    text: "No secrets or API keys in code",
    severity: "error",
    locked: true,
    source: "starter"
  }
];
const CHUNK = { text: "@@ -1 +1 @@\n+const a = 1;", files: [] };

function answering(text: string, finish: "stop" | "length" = "stop") {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: finish, raw: finish },
      usage: {
        inputTokens: {
          total: 1200,
          noCache: 1200,
          cacheRead: undefined,
          cacheWrite: undefined
        },
        outputTokens: { total: 80, text: 80, reasoning: undefined }
      },
      warnings: []
    })
  });
}

const FINDING = {
  ruleId: "no-secrets",
  file: "src/a.ts",
  line: 1,
  message: "A key.",
  suggestion: "Move it."
};

describe("reviewChunk", () => {
  it("gives the review model no tools, asks for JSON, and caps the answer", async () => {
    const model = answering('{"findings": []}');
    await reviewChunk(model, CHUNK, RULES);
    const [call] = model.doGenerateCalls;
    expect(call.tools ?? []).toEqual([]);
    expect(call.toolChoice).toBeUndefined();
    expect(call.responseFormat?.type).toBe("json");
    expect(call.maxOutputTokens).toBe(MODEL.maxOutputTokens);
  });

  it("returns every finding raw, malformed ones included, for validation", async () => {
    const model = answering(
      JSON.stringify({ findings: [FINDING, { ruleId: "no-secrets" }] })
    );
    const { raw } = await reviewChunk(model, CHUNK, RULES);
    expect(raw).toEqual([FINDING, { ruleId: "no-secrets" }]);
  });

  it("returns the call's token usage", async () => {
    const { usage } = await reviewChunk(
      answering('{"findings": []}'),
      CHUNK,
      RULES
    );
    expect(usage).toEqual({ inputTokens: 1200, outputTokens: 80 });
  });

  it.each([
    ["isn't JSON", "I found no problems."],
    ["has no findings list", '{"result": "pass"}'],
    ["has a findings value that isn't a list", '{"findings": "none"}']
  ])("throws when the answer %s, so the step retries", async (_case, text) => {
    await expect(reviewChunk(answering(text), CHUNK, RULES)).rejects.toThrow();
  });

  it("throws on an answer cut off at max_tokens, even if it parses", async () => {
    await expect(
      reviewChunk(answering('{"findings": []}', "length"), CHUNK, RULES)
    ).rejects.toBeInstanceOf(MalformedReviewError);
  });

  it("calls the model once: retries belong to the workflow step", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new APICallError({
          message: "out of capacity",
          url: "workers-ai",
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: true
        });
      }
    });
    await expect(reviewChunk(model, CHUNK, RULES)).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
