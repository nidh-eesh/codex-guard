import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { readRules, RuleError, type RuleTables } from "./rule-changes";
import { ruleTools, toolErrorText, userTextsOf } from "./rule-tools";
import type { CustomRule, DisabledDefault } from "./rules";

function memoryTables(): RuleTables {
  let custom: CustomRule[] = [];
  let disabled: DisabledDefault[] = [];
  return {
    customRules: () => [...custom],
    disabledDefaults: () => [...disabled],
    insertCustomRule: (rule) => void custom.push(rule),
    deleteCustomRule: (id) => void (custom = custom.filter((r) => r.id !== id)),
    insertDisabledDefault: (row) => void disabled.push(row),
    deleteDisabledDefault: (ruleId) =>
      void (disabled = disabled.filter((r) => r.ruleId !== ruleId))
  };
}

const REASON = "Covered by our own linting";

/** A tool call's options, with the user's messages the model could see. */
function call(...userTexts: string[]) {
  return {
    toolCallId: "call-1",
    messages: userTexts.map(
      (text): ModelMessage => ({ role: "user", content: text })
    )
  };
}
const saidReason = call(`Switch those off, ${REASON.toLowerCase()}`);

// needsApproval as the ai package calls it: with the input and the history
async function needsApproval(
  tool: { needsApproval?: unknown },
  input: unknown,
  options = saidReason
): Promise<boolean> {
  const setting = tool.needsApproval;
  return typeof setting === "function"
    ? Boolean(await setting(input, options))
    : Boolean(setting);
}

const run = (
  tool: { execute?: unknown },
  input: unknown,
  options = saidReason
) =>
  (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(
    input,
    options
  );

describe("ruleTools", () => {
  it("asks a person before adding a rule of valid length, and never for listing", async () => {
    const tools = ruleTools(memoryTables(), () => {});
    expect(
      await needsApproval(tools.addRule, {
        text: "Use the shared HTTP client",
        severity: "warning"
      })
    ).toBe(true);
    expect(tools.listRules.needsApproval).toBeFalsy();
  });

  it.each([
    [
      "addRule",
      "text under 10 characters",
      { text: "Short", severity: "warning" },
      saidReason
    ],
    [
      "removeRule",
      "a recommended rule with no reason",
      { ruleIds: ["validate-input"] },
      saidReason
    ],
    [
      "removeRule",
      "a placeholder reason",
      { ruleIds: ["validate-input"], reason: "Not needed" },
      call("Not needed")
    ],
    // The local incident: an invented reason, approved 4 times before D28
    [
      "removeRule",
      "a reason the user never wrote",
      {
        ruleIds: ["validate-input"],
        reason: "This rule is not necessary for our project"
      },
      call("Disable all rules")
    ],
    [
      "removeRule",
      "locked rules only",
      { ruleIds: ["no-secrets", "sql-parameterized"], reason: REASON },
      saidReason
    ],
    ["restoreRule", "a locked rule", { ruleIds: ["no-secrets"] }, saidReason],
    // Seen live: the model named the rule "all". Not a locked rule's exact
    // ID either: execute won't treat NO-SECRETS as no-secrets
    [
      "removeRule",
      "an ID no rule could have",
      { ruleIds: ["all"], reason: "No reason provided" },
      saidReason
    ],
    [
      "removeRule",
      "a locked rule's ID in other case",
      { ruleIds: ["NO-SECRETS"], reason: REASON },
      saidReason
    ]
  ] as const)(
    "refuses %s on %s without asking, and changes nothing (D28)",
    async (toolName, _case, input, options) => {
      const tables = memoryTables();
      const onChange = vi.fn();
      const tool = ruleTools(tables, onChange)[toolName];
      const before = readRules(tables);
      expect(await needsApproval(tool, input, options)).toBe(false);
      await expect(run(tool, input, options)).rejects.toThrow(RuleError);
      expect(readRules(tables)).toEqual(before);
      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "an unlocked starter rule, with the user's reason",
      "removeRule",
      { ruleIds: ["validate-input"], reason: REASON }
    ],
    ["a custom rule", "removeRule", { ruleIds: ["c_1a2b3c4d"] }],
    [
      "a custom-shaped ID that may exist",
      "removeRule",
      { ruleIds: ["c_99999999"] }
    ],
    [
      "one rule that can change among locked ones",
      "removeRule",
      { ruleIds: ["no-secrets", "validate-input"], reason: REASON }
    ],
    ["an unlocked rule", "restoreRule", { ruleIds: ["validate-input"] }]
  ] as const)("needs approval for %s (D28)", async (_case, toolName, input) => {
    const tools = ruleTools(memoryTables(), () => {});
    expect(await needsApproval(tools[toolName], input)).toBe(true);
  });

  it("checks the reason against the history each call arrives with", async () => {
    const tools = ruleTools(memoryTables(), () => {});
    const input = { ruleIds: ["no-console-log"], reason: REASON };
    await expect(
      run(tools.removeRule, input, call("Disable all rules"))
    ).rejects.toThrow("The reason must be in the user's own words");
    expect(await run(tools.removeRule, input)).toMatchObject({
      switchedOff: ["no-console-log"],
      reason: REASON
    });
  });

  it("offers the chat model exactly the four rule tools", () => {
    expect(Object.keys(ruleTools(memoryTables(), () => {})).sort()).toEqual([
      "addRule",
      "listRules",
      "removeRule",
      "restoreRule"
    ]);
  });

  it("lists the active and switched-off rules", async () => {
    const tables = memoryTables();
    const tools = ruleTools(tables, () => {});
    expect(await run(tools.listRules, {})).toEqual(readRules(tables));
  });

  it("pushes the rules once after a change", async () => {
    const onChange = vi.fn();
    const tools = ruleTools(memoryTables(), onChange, () => 42);
    const output = await run(tools.addRule, {
      text: "Use the shared HTTP client",
      severity: "warning"
    });
    expect(output).toMatchObject({ added: { createdAt: 42 } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports each rule in one call, and pushes once (D29)", async () => {
    const onChange = vi.fn();
    const tools = ruleTools(memoryTables(), onChange);
    expect(
      await run(tools.removeRule, {
        ruleIds: ["no-console-log", "explicit-errors", "no-secrets"],
        reason: REASON
      })
    ).toMatchObject({
      switchedOff: ["no-console-log", "explicit-errors"],
      refused: [{ ruleId: "no-secrets" }]
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      await run(tools.restoreRule, {
        ruleIds: ["no-console-log", "explicit-errors"]
      })
    ).toMatchObject({
      restored: ["no-console-log", "explicit-errors"],
      refused: []
    });
  });

  it("fails a refused change with its §5 message and doesn't push", async () => {
    const onChange = vi.fn();
    const tools = ruleTools(memoryTables(), onChange);
    await expect(
      run(tools.removeRule, { ruleIds: ["no-secrets"], reason: REASON })
    ).rejects.toThrow(
      "Rule `no-secrets` is locked and can't be switched off. Locked rules can't be changed; don't try again."
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("userTextsOf", () => {
  it("reads the text of the user's messages only", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Switch off console log" },
      { role: "assistant", content: "Why?" },
      {
        role: "user",
        content: [
          { type: "text", text: "Our logger" },
          { type: "text", text: "replaces it" }
        ]
      }
    ];
    expect(userTextsOf(messages)).toEqual([
      "Switch off console log",
      "Our logger",
      "replaces it"
    ]);
  });
});

describe("toolErrorText", () => {
  it("shows a refused rule change's own message", () => {
    expect(toolErrorText(new RuleError("Rule `x` is not switched off."))).toBe(
      "Rule `x` is not switched off."
    );
  });

  it.each([
    ["another error", new Error("SQLITE_CONSTRAINT: custom_rules.id")],
    ["a thrown string", "boom"],
    ["nothing", undefined]
  ])("hides %s behind a generic message", (_case, error) => {
    expect(toolErrorText(error)).toBe("An error occurred.");
  });
});
