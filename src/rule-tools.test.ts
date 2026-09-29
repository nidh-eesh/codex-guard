import { describe, expect, it, vi } from "vitest";
import { readRules, RuleError, type RuleTables } from "./rule-changes";
import { ruleTools, toolErrorText } from "./rule-tools";
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

const call = { toolCallId: "call-1", messages: [] };

describe("ruleTools", () => {
  // needsApproval as the ai package calls it: with the call's input
  async function needsApproval(
    tool: { needsApproval?: unknown },
    input: unknown
  ): Promise<boolean> {
    const setting = tool.needsApproval;
    return typeof setting === "function"
      ? Boolean(await setting(input, { toolCallId: "call-1", messages: [] }))
      : Boolean(setting);
  }

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
      { text: "Short", severity: "warning" }
    ],
    [
      "removeRule",
      "a recommended rule with no reason",
      { ruleId: "validate-input" }
    ],
    [
      "removeRule",
      "a recommended rule with a placeholder reason",
      { ruleId: "validate-input", reason: "Not needed" }
    ]
  ] as const)(
    "refuses %s on %s without asking, and changes nothing (D28)",
    async (toolName, _case, input) => {
      const tables = memoryTables();
      const onChange = vi.fn();
      const tools = ruleTools(tables, onChange);
      const before = readRules(tables);
      const tool = tools[toolName];
      expect(await needsApproval(tool, input)).toBe(false);
      await expect(
        (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(
          input,
          call
        )
      ).rejects.toThrow(RuleError);
      expect(readRules(tables)).toEqual(before);
      expect(onChange).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["an unlocked starter rule", "validate-input"],
    ["a custom rule", "c_1a2b3c4d"],
    ["an unknown rule", "no-such-rule"],
    // Not the locked rule's exact ID: execute won't treat it as that rule
    ["a locked rule's ID in other case", "NO-SECRETS"]
  ])("needs approval to remove or restore %s (D28)", async (_case, ruleId) => {
    const tools = ruleTools(memoryTables(), () => {});
    const input = { ruleId, reason: "Covered by another check" };
    expect(await needsApproval(tools.removeRule, input)).toBe(true);
    expect(await needsApproval(tools.restoreRule, { ruleId })).toBe(true);
  });

  it.each(["no-secrets", "sql-parameterized"])(
    "refuses a call on the locked rule %s without asking, and changes nothing (D28)",
    async (ruleId) => {
      const tables = memoryTables();
      const onChange = vi.fn();
      const tools = ruleTools(tables, onChange);
      const before = readRules(tables);
      expect(await needsApproval(tools.removeRule, { ruleId })).toBe(false);
      expect(await needsApproval(tools.restoreRule, { ruleId })).toBe(false);
      await expect(
        tools.removeRule.execute!({ ruleId, reason: "Not needed here" }, call)
      ).rejects.toThrow("Locked rules can't be changed; don't try again.");
      await expect(
        tools.restoreRule.execute!({ ruleId }, call)
      ).rejects.toThrow(RuleError);
      expect(readRules(tables)).toEqual(before);
      expect(onChange).not.toHaveBeenCalled();
    }
  );

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
    expect(await tools.listRules.execute!({}, call)).toEqual(readRules(tables));
  });

  it("pushes the rules once after a change", async () => {
    const onChange = vi.fn();
    const tools = ruleTools(memoryTables(), onChange, () => 42);
    const output = await tools.addRule.execute!(
      { text: "Use the shared HTTP client", severity: "warning" },
      call
    );
    expect(output).toMatchObject({ added: { createdAt: 42 } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports whether removeRule deleted or switched off", async () => {
    const tools = ruleTools(memoryTables(), () => {});
    expect(
      await tools.removeRule.execute!(
        { ruleId: "no-console-log", reason: "CLI output" },
        call
      )
    ).toEqual({ switchedOff: "no-console-log", reason: "CLI output" });
    expect(
      await tools.restoreRule.execute!({ ruleId: "no-console-log" }, call)
    ).toEqual({ restored: "no-console-log" });
  });

  it("fails a refused change with its §5 message and doesn't push", async () => {
    const onChange = vi.fn();
    const tools = ruleTools(memoryTables(), onChange);
    await expect(
      tools.removeRule.execute!({ ruleId: "no-secrets", reason: "x" }, call)
    ).rejects.toThrow("Rule `no-secrets` is locked and can't be switched off.");
    expect(onChange).not.toHaveBeenCalled();
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
