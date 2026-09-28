import type { WorkflowStepConfig } from "cloudflare:workers";
import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import { createWorkersAI } from "workers-ai-provider";
import { MODEL } from "./model-config";
import { runReview } from "./review-pipeline";
import type { ActiveRule } from "./rules";
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
 * DESIGN.md 6: split, review each chunk, combine. Each step's result is
 * persisted, so a failed chunk retries alone.
 */
export class ReviewWorkflow extends AgentWorkflow<ChatAgent, ReviewParams> {
  async run(event: AgentWorkflowEvent<ReviewParams>, step: AgentWorkflowStep) {
    const { diff, rules } = event.payload;
    const model = createWorkersAI({ binding: this.env.AI })(MODEL.id);
    const result = await runReview(diff, rules, model, (name, work) =>
      step.do(name, STEP, work)
    );
    await step.reportComplete(result);
  }
}
