import { tool } from "ai";
import { z } from "zod";
import {
  addRule,
  argumentRefusal,
  readRules,
  removeRule,
  restoreRule,
  RuleError,
  type RuleTables
} from "./rule-changes";

/**
 * The text shown for a failed tool call: a RuleError's own message
 * (DESIGN.md §5), and a generic one for anything else, so internal errors
 * don't reach the browser or the model.
 */
export function toolErrorText(error: unknown): string {
  return error instanceof RuleError ? error.message : "An error occurred.";
}

const ruleId = z
  .string()
  .max(64)
  .describe("The rule's ID, exactly as listRules shows it");

/**
 * A call refused on its arguments alone (a locked rule, a length limit, a
 * missing or placeholder reason) can't change anything whenever it runs, so
 * it runs without asking a person and `execute` refuses it at once. A call
 * whose outcome depends on the rules in SQLite waits for approval (D28).
 */
const unlessRefusedOnArguments =
  (toolName: string) =>
  (input: unknown): boolean =>
    argumentRefusal(toolName, input) === undefined;

/**
 * The chat model's tools. Rules change only inside the `execute` of addRule,
 * removeRule and restoreRule, and a person approves each call that could
 * change a rule before it runs (D4, D28). `execute` checks everything again
 * at that point: the rules may have changed while the call waited.
 */
export function ruleTools(
  tables: RuleTables,
  onChange: () => void,
  now: () => number = Date.now
) {
  return {
    listRules: tool({
      description:
        "List the workspace's active rules, and the recommended rules it has switched off with the reason for each.",
      inputSchema: z.object({}),
      execute: async () => readRules(tables)
    }),

    addRule: tool({
      description: "Add a custom rule. A person approves the change first.",
      inputSchema: z.object({
        text: z.string().describe("What the rule requires, 10-200 characters"),
        severity: z
          .enum(["error", "warning"])
          .describe(
            "error: a violation fails the review. warning: it's reported, but the review can still pass."
          )
      }),
      needsApproval: unlessRefusedOnArguments("addRule"),
      execute: async (input) => {
        const rule = addRule(tables, input, now());
        onChange();
        return { added: rule };
      }
    }),

    removeRule: tool({
      description:
        "Delete a custom rule, or switch off a recommended rule, which needs a reason. Locked rules can't be removed. A person approves the change first.",
      inputSchema: z.object({
        ruleId,
        reason: z
          .string()
          .optional()
          .describe(
            "Why the team is switching off a recommended rule, in the user's own words, 10-200 characters. If the user hasn't said why, ask them; never make one up."
          )
      }),
      needsApproval: unlessRefusedOnArguments("removeRule"),
      execute: async (input) => {
        const removal = removeRule(tables, input, now());
        onChange();
        return removal.kind === "deleted"
          ? { deleted: removal.rule.id }
          : { switchedOff: removal.rule.id, reason: removal.reason };
      }
    }),

    restoreRule: tool({
      description:
        "Switch a recommended rule back on. A person approves the change first.",
      inputSchema: z.object({ ruleId }),
      needsApproval: unlessRefusedOnArguments("restoreRule"),
      execute: async (input) => {
        const rule = restoreRule(tables, input);
        onChange();
        return { restored: rule.id };
      }
    })
  };
}
