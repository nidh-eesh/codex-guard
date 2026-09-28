import type { LanguageModel } from "ai";
import { splitDiff } from "./diff-split";
import { validateFindings } from "./finding-validation";
import { combineReview } from "./review-combine";
import { reviewChunk } from "./review-model";
import { MAX_FINDINGS_PER_CHUNK } from "./review-prompt";
import { redactReview } from "./review-summary";
import type { Chunk, ChunkOutcome, ReviewResult } from "./review-types";
import type { ActiveRule } from "./rules";
import { findSecrets, redactSecrets } from "./secrets";

/**
 * Runs one named step and returns its result. The workflow persists and
 * retries each step with `step.do`; the evals retry in memory.
 */
export type RunStep = <T extends Rpc.Serializable<T>>(
  name: string,
  work: () => Promise<T>
) => Promise<T>;

/** One chunk: call the review model, validate its findings, redact them. */
export async function reviewAndValidate(
  model: LanguageModel,
  chunk: Chunk,
  rules: readonly ActiveRule[]
): Promise<ChunkOutcome> {
  const { raw, usage } = await reviewChunk(model, chunk, rules);
  const validated = validateFindings(raw, chunk, rules);
  return {
    reviewed: true,
    usage,
    atCap: raw.length >= MAX_FINDINGS_PER_CHUNK,
    ...validated,
    // Redacted before the step returns, so Workflows never stores a key
    findings: validated.findings.map((finding) => ({
      ...finding,
      message: redactSecrets(finding.message),
      suggestion: redactSecrets(finding.suggestion)
    }))
  };
}

/** DESIGN.md §6: split, review each chunk, combine. */
export async function runReview(
  diff: string,
  rules: readonly ActiveRule[],
  model: LanguageModel,
  step: RunStep
): Promise<ReviewResult> {
  const split = await step("split", async () => splitDiff(diff));

  const outcomes = await Promise.all(
    split.chunks.map((chunk, i) =>
      step(`review chunk ${i + 1}`, () =>
        reviewAndValidate(model, chunk, rules)
      )
        // Still failing after its retries: not reviewed, and the review goes
        // on (D10)
        .catch((): ChunkOutcome => ({ reviewed: false }))
    )
  );

  return step("combine", async () =>
    redactReview(
      combineReview({
        outcomes,
        secretFindings: findSecrets(split.addedLines),
        skipped: split.skipped,
        rules
      })
    )
  );
}
