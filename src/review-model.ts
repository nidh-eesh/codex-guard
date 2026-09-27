import { generateText, jsonSchema, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { MODEL } from "./model-config";
import {
  buildReviewPrompt,
  newMarkerTag,
  REVIEW_RESPONSE_SCHEMA,
  REVIEW_SYSTEM_PROMPT
} from "./review-prompt";
import type { ActiveRule } from "./rules";
import type { Chunk, TokenUsage } from "./review-types";

/** An answer the review can't use. The workflow step retries the call. */
export class MalformedReviewError extends Error {}

// Only the top level is checked here. Each finding is validated on its own
// later, so one bad finding is dropped instead of failing the whole answer.
const ReviewResponse = z.object({ findings: z.array(z.unknown()) });

const responseSchema = jsonSchema<{ findings: unknown[] }>(
  REVIEW_RESPONSE_SCHEMA,
  {
    validate: (value) => {
      const parsed = ReviewResponse.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : {
            success: false,
            error: new MalformedReviewError("The answer has no findings list.")
          };
    }
  }
);

/**
 * One review model call for one chunk. The review model gets no tools
 * (DESIGN.md §7, layer 1): no `tools` are passed, and JSON mode sends none.
 * Throws on a malformed or cut-off answer.
 */
export async function reviewChunk(
  model: LanguageModel,
  chunk: Chunk,
  rules: readonly ActiveRule[],
  tag: string = newMarkerTag()
): Promise<{ raw: unknown[]; usage: TokenUsage }> {
  const result = await generateText({
    model,
    system: REVIEW_SYSTEM_PROMPT,
    prompt: buildReviewPrompt(chunk, rules, tag),
    maxOutputTokens: MODEL.maxOutputTokens,
    // Retries belong to the workflow step, at most 2 (D10). The SDK's own
    // retries would multiply them.
    maxRetries: 0,
    output: Output.object({ schema: responseSchema })
  });
  // A cut-off answer must never look like a short, clean one
  if (result.finishReason === "length") {
    throw new MalformedReviewError("The answer was cut off at max_tokens.");
  }
  return {
    raw: result.output.findings,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0
    }
  };
}
