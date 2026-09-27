import type { WorkflowStepConfig } from "cloudflare:workers";
import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { createWorkersAI } from "workers-ai-provider";
import { splitDiff } from "./diff-split";
import { validateFindings } from "./finding-validation";
import { MODEL } from "./model-config";
import { combineReview } from "./review-combine";
import { reviewChunk } from "./review-model";
import { redactReview } from "./review-summary";
import type { ChunkOutcome } from "./review-types";
import type { ActiveRule } from "./rules";
import { findSecrets, redactSecrets } from "./secrets";
import type { ChatAgent } from "./server";

export interface ReviewParams {
  diff: string;
  /** The active rules when the diff was submitted. The whole review uses them. */
  rules: ActiveRule[];
}

// At most 2 retries, 2 seconds apart, instead of the Workflows default of 5
// starting at 10 seconds (D10). Outputs hold findings, so they're sensitive.
const STEP = {
  retries: { limit: 2, delay: "2 seconds", backoff: "constant" },
  sensitive: "output"
} as const satisfies WorkflowStepConfig;

/**
 * DESIGN.md §6: split, review each chunk, combine. Each step's result is
 * persisted, so a failed chunk retries alone.
 */
export class ReviewWorkflow extends AgentWorkflow<ChatAgent, ReviewParams> {
  async run(event: AgentWorkflowEvent<ReviewParams>, step: AgentWorkflowStep) {
    const { diff, rules } = event.payload;
    const split = await step.do("split", STEP, async () => splitDiff(diff));
    const model = createWorkersAI({ binding: this.env.AI })(MODEL.id);

    const outcomes = await Promise.all(
      split.chunks.map((chunk, i) =>
        step
          .do(
            `review chunk ${i + 1}`,
            STEP,
            async (): Promise<ChunkOutcome> => {
              const { raw, usage } = await reviewChunk(model, chunk, rules);
              const validated = validateFindings(raw, chunk, rules);
              // Redacted before the step returns, so Workflows never stores a key
              return {
                reviewed: true,
                usage,
                ...validated,
                findings: validated.findings.map((finding) => ({
                  ...finding,
                  message: redactSecrets(finding.message),
                  suggestion: redactSecrets(finding.suggestion)
                }))
              };
            }
          )
          // Still failing after its retries: not reviewed, and the review
          // goes on (D10)
          .catch((): ChunkOutcome => ({ reviewed: false }))
      )
    );

    const result = await step.do("combine", STEP, async () =>
      redactReview(
        combineReview({
          outcomes,
          secretFindings: findSecrets(split.addedLines),
          skipped: split.skipped,
          rules
        })
      )
    );
    await step.reportComplete(result);
  }
}
