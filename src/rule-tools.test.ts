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
  it("needs a person's approval for every tool that changes rules", () => {
    const tools = ruleTools(memoryTables(), () => {});
    expect(tools.addRule.needsApproval).toBe(true);
    expect(tools.removeRule.needsApproval).toBe(true);
    expect(tools.restoreRule.needsApproval).toBe(true);
    expect(tools.listRules.needsApproval).toBeFalsy();
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
