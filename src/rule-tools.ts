import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import {
  addRule,
  readRules,
  refusedOnCallAlone,
  removeRules,
  restoreRules,
  RuleError,
  ruleIdsOf,
  type RuleTables
} from "./rule-changes";
import { MAX_ACTIVE_RULES } from "./rules";

/**
 * The text shown for a failed tool call: a RuleError's own message
 * (DESIGN.md §5), and a generic one for anything else, so internal errors
 * don't reach the browser or the model.
 */
export function toolErrorText(error: unknown): string {
  return error instanceof RuleError ? error.message : "An error occurred.";
}

const ruleIds = z
  .array(z.string().max(64))
  .min(1)
  .max(MAX_ACTIVE_RULES)
  .describe("Every rule to change, by ID exactly as listRules shows it");

/**
 * The text of the user's messages the model can see: its 10-message window
 * (D26). A switch-off reason must come from here (D28).
 */
export function userTextsOf(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    return typeof message.content === "string"
      ? [message.content]
      : message.content.flatMap((part) =>
          part.type === "text" ? [part.text] : []
        );
  });
}

/**
 * A call that nothing in it could pass, whatever the rules in SQLite are (a
 * locked rule, a length limit, a missing, placeholder or unquoted reason),
 * runs without asking a person, and `execute` refuses it at once. A call
 * with any change whose outcome depends on the rules waits for approval
 * (D28).
 */
const unlessRefusedOnCallAlone =
  (toolName: string) =>
  (input: unknown, { messages }: { messages: ModelMessage[] }): boolean =>
    !refusedOnCallAlone(toolName, input, userTextsOf(messages));

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
      needsApproval: unlessRefusedOnCallAlone("addRule"),
      execute: async (input) => {
        const rule = addRule(tables, input, now());
        onChange();
        return { added: rule };
      }
    }),

    removeRule: tool({
      description:
        "Delete custom rules, or switch off recommended rules, which needs a reason. Name every rule to change in one call; one reason covers them all. Locked rules can't be removed. A person approves the change first.",
      inputSchema: z.object({
        ruleIds,
        reason: z
          .string()
          .optional()
          .describe(
            "Why the team is switching off the recommended rules, copied exactly from the user's message, 10-200 characters. If the user hasn't said why, ask them; never make one up."
          )
      }),
      needsApproval: unlessRefusedOnCallAlone("removeRule"),
      execute: async (input, { messages }) => {
        // Applies what it can and reports each rule; throws if nothing changed
        const report = removeRules(
          tables,
          { ruleIds: ruleIdsOf(input), reason: input.reason },
          now(),
          userTextsOf(messages)
        );
        onChange();
        return report;
      }
    }),

    restoreRule: tool({
      description:
        "Switch recommended rules back on. Name every rule in one call. A person approves the change first.",
      inputSchema: z.object({ ruleIds }),
      needsApproval: unlessRefusedOnCallAlone("restoreRule"),
      execute: async (input) => {
        const report = restoreRules(tables, { ruleIds: ruleIdsOf(input) });
        onChange();
        return report;
      }
    })
  };
}
