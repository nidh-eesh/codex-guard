import {
  InvalidToolInputError,
  NoSuchToolError,
  tool,
  type ModelMessage,
  type UIMessage
} from "ai";
import { z } from "zod";
import {
  addRules,
  changeableRules,
  readRules,
  removableIds,
  removeRules,
  restorableIds,
  restoreRules,
  RuleError,
  ruleIdsOf,
  rulesToAdd,
  schemaRefusal,
  unapprovedRefusal,
  wouldBeRefused,
  type RuleTables
} from "./rule-changes";
import { MAX_ACTIVE_RULES, type ResolvedRules } from "./rules";
import { approvedInLatestTurn, type UnapprovedCalls } from "./tool-approval";

/**
 * The text shown for a failed tool call: a RuleError's own message
 * (DESIGN.md §5), and a generic one for anything else, so internal errors
 * don't reach the browser or the model. Given the rules, a call the tool's
 * schema rejected, or a call to a tool left out this turn, gets the same
 * refusal our own checks would give (D31).
 */
export function toolErrorText(error: unknown, rules?: ResolvedRules): string {
  if (error instanceof RuleError) return error.message;
  if (rules && InvalidToolInputError.isInstance(error)) {
    let input: unknown;
    try {
      input = JSON.parse(error.toolInput);
    } catch {
      input = undefined;
    }
    return schemaRefusal(error.toolName, input, rules).message;
  }
  if (
    rules &&
    NoSuchToolError.isInstance(error) &&
    (error.toolName === "removeRule" || error.toolName === "restoreRule")
  ) {
    return changeableRules(error.toolName, rules);
  }
  return "An error occurred.";
}

/**
 * The error text for one turn's stream. A call the tool's schema rejected,
 * or a call to a tool left out this turn, is reported twice: first with its
 * error, then as a plain string of that error's message. Both get the same
 * refusal, so the card shows it rather than a generic error.
 */
export function toolErrorTexts(
  rules: () => ResolvedRules
): (error: unknown) => string {
  const explained = new Map<string, string>();
  return (error) => {
    if (typeof error === "string" && explained.has(error)) {
      return explained.get(error)!;
    }
    const text = toolErrorText(error, rules());
    if (
      InvalidToolInputError.isInstance(error) ||
      NoSuchToolError.isInstance(error)
    ) {
      explained.set(error.message, text);
    }
    return text;
  };
}

/**
 * A rule-ID list whose schema allows only `ids`, which the server generates
 * (starter IDs from code, custom IDs from UUIDs), so no user-written text
 * reaches the tool definitions (D31).
 */
const ruleIdsFrom = (ids: readonly string[]) =>
  z
    .array(z.enum(ids as [string, ...string[]]))
    .min(1)
    .max(MAX_ACTIVE_RULES)
    .describe("Every rule to change, by ID");

/**
 * The rule IDs of the rule changes approved in the latest assistant
 * message, which this turn runs first. They stay in this turn's lists, so
 * the ai package's check of an approved call's input passes, and its
 * execute gives the real refusal if the rules changed since (D31).
 */
export function approvedPendingIds(messages: readonly UIMessage[]): {
  removeRule: string[];
  restoreRule: string[];
} {
  const pending = { removeRule: [] as string[], restoreRule: [] as string[] };
  const latest = messages.at(-1);
  if (latest?.role !== "assistant") return pending;
  for (const part of latest.parts) {
    const call = part as {
      type: string;
      state?: string;
      input?: unknown;
      approval?: { approved?: boolean };
    };
    if (call.state !== "approval-responded" || !call.approval?.approved) {
      continue;
    }
    if (call.type === "tool-removeRule") {
      pending.removeRule.push(...ruleIdsOf(call.input));
    } else if (call.type === "tool-restoreRule") {
      pending.restoreRule.push(...ruleIdsOf(call.input));
    }
  }
  return pending;
}

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

/** Every rule tool's name, whether or not a turn offers it (D31). */
export const RULE_TOOL_NAMES = [
  "listRules",
  "addRule",
  "removeRule",
  "restoreRule"
] as const;

/**
 * The chat model's tools. Rules change only inside an approved `execute`: a
 * call that would be refused is refused at once without asking, and an
 * `execute` that wasn't approved can only refuse (D30). A write needs both
 * checks: `needsApproval` didn't let the call through unasked, and a person
 * approved it in the latest turn. `execute` checks the rules again, since
 * they may have changed while the call waited.
 */
export function ruleTools(
  tables: RuleTables,
  unapproved: UnapprovedCalls,
  onChange: () => void,
  {
    now = Date.now,
    pending = { removeRule: [], restoreRule: [] }
  }: {
    now?: () => number;
    pending?: { removeRule: string[]; restoreRule: string[] };
  } = {}
) {
  // Rebuilt every turn from SQLite: each tool's schema lists the IDs it can
  // change now (D31). A tool with nothing to change is left out, since an
  // empty enum isn't valid JSON Schema
  const rules = readRules(tables);
  const removable = [
    ...new Set([...removableIds(rules), ...pending.removeRule])
  ];
  const restorable = [
    ...new Set([...restorableIds(rules), ...pending.restoreRule])
  ];

  // Asks a person only if some change in the call could happen; a call let
  // through unasked is recorded, so its execute can't write. The ai package
  // calls this again for an approved call before running it, and turns a
  // false into a denial. So a call approved in the latest turn keeps its
  // approval: its execute then checks the rules again and gives the real
  // refusal, or writes if the change is still valid
  const needsApproval =
    (toolName: string) =>
    (
      input: unknown,
      { toolCallId, messages }: { toolCallId: string; messages: ModelMessage[] }
    ): boolean => {
      const needs =
        approvedInLatestTurn(toolCallId, messages) ||
        !wouldBeRefused(
          toolName,
          input,
          readRules(tables),
          userTextsOf(messages)
        );
      if (needs) unapproved.clear(toolCallId);
      else unapproved.mark(toolCallId);
      return needs;
    };

  // Throws the call's refusal unless it may write
  const refuseUnlessApproved = (
    toolName: string,
    input: unknown,
    { toolCallId, messages }: { toolCallId: string; messages: ModelMessage[] }
  ) => {
    if (
      !unapproved.has(toolCallId) &&
      approvedInLatestTurn(toolCallId, messages)
    ) {
      return;
    }
    throw unapprovedRefusal(
      toolName,
      input,
      readRules(tables),
      userTextsOf(messages)
    );
  };

  return {
    listRules: tool({
      description:
        "List the workspace's active rules, and the recommended rules it has switched off with the reason for each.",
      inputSchema: z.object({}),
      execute: async () => readRules(tables)
    }),

    addRule: tool({
      description:
        "Add custom rules. Name every rule to add in one call. A person approves the change first.",
      inputSchema: z.object({
        rules: z
          .array(
            z.object({
              text: z
                .string()
                .describe("What the rule requires, 10-200 characters"),
              severity: z
                .enum(["error", "warning"])
                .describe(
                  "error: a violation fails the review. warning: it's reported, but the review can still pass."
                )
            })
          )
          .min(1)
          .max(MAX_ACTIVE_RULES)
          .describe("Every rule to add")
      }),
      needsApproval: needsApproval("addRule"),
      execute: async (input, options) => {
        refuseUnlessApproved("addRule", input, options);
        // Adds what it can and reports each rule; throws if nothing was added
        const report = addRules(tables, { rules: rulesToAdd(input) }, now());
        onChange();
        return report;
      }
    }),

    ...(removable.length > 0 && {
      removeRule: tool({
        description:
          "Delete custom rules, or switch off recommended rules, which needs a reason. Name every rule to change in one call; one reason covers them all. Locked rules can't be removed. A person approves the change first.",
        inputSchema: z.object({
          ruleIds: ruleIdsFrom(removable),
          reason: z
            .string()
            .optional()
            .describe(
              "Why the team is switching off the recommended rules, copied exactly from the user's message, 10-200 characters. If the user hasn't said why, ask them; never make one up."
            )
        }),
        needsApproval: needsApproval("removeRule"),
        execute: async (input, options) => {
          refuseUnlessApproved("removeRule", input, options);
          // Applies what it can and reports each rule; throws if nothing changed
          const report = removeRules(
            tables,
            { ruleIds: ruleIdsOf(input), reason: input.reason },
            now(),
            userTextsOf(options.messages)
          );
          onChange();
          return report;
        }
      })
    }),

    ...(restorable.length > 0 && {
      restoreRule: tool({
        description:
          "Switch recommended rules back on. Name every rule in one call. A person approves the change first.",
        inputSchema: z.object({ ruleIds: ruleIdsFrom(restorable) }),
        needsApproval: needsApproval("restoreRule"),
        execute: async (input, options) => {
          refuseUnlessApproved("restoreRule", input, options);
          const report = restoreRules(tables, { ruleIds: ruleIdsOf(input) });
          onChange();
          return report;
        }
      })
    })
  };
}
