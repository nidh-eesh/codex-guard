import { describe, expect, it } from "vitest";
import {
  addRule,
  newCustomRuleId,
  readRules,
  removeRule,
  restoreRule,
  RuleError,
  type RuleTables
} from "./rule-changes";
import { STARTER_PACK, type CustomRule, type DisabledDefault } from "./rules";

const NOW = 1_700_000_000_000;

/** In-memory tables that, like SQLite's primary keys, refuse duplicate IDs. */
function memoryTables(
  custom: CustomRule[] = [],
  disabled: DisabledDefault[] = []
) {
  const data = { custom: [...custom], disabled: [...disabled] };
  const tables: RuleTables = {
    customRules: () => [...data.custom],
    disabledDefaults: () => [...data.disabled],
    insertCustomRule: (rule) => {
      if (data.custom.some((r) => r.id === rule.id)) throw new Error("PK");
      data.custom.push(rule);
    },
    deleteCustomRule: (id) => {
      data.custom = data.custom.filter((r) => r.id !== id);
    },
    insertDisabledDefault: (row) => {
      if (data.disabled.some((r) => r.ruleId === row.ruleId)) {
        throw new Error("PK");
      }
      data.disabled.push(row);
    },
    deleteDisabledDefault: (ruleId) => {
      data.disabled = data.disabled.filter((r) => r.ruleId !== ruleId);
    }
  };
  return { tables, data };
}

function customRule(n: number, fields: Partial<CustomRule> = {}): CustomRule {
  return {
    id: `c_${String(n).padStart(8, "0")}`,
    text: `Custom rule number ${n}`,
    severity: "warning",
    createdAt: n,
    ...fields
  };
}

/** Custom rules that bring the active total to exactly 50 with the pack. */
const fillToLimit = (starterActive: number = STARTER_PACK.length) =>
  Array.from({ length: 50 - starterActive }, (_, i) => customRule(i + 1));

function switchedOffRow(
  ruleId: string,
  fields: Partial<DisabledDefault> = {}
): DisabledDefault {
  const text = STARTER_PACK.find((rule) => rule.id === ruleId)?.text ?? "Old";
  return {
    ruleId,
    reason: "Not relevant here",
    ruleText: text,
    disabledAt: 1,
    ...fields
  };
}

/** Expects a RuleError with exactly this message, and no change to the tables. */
function expectRefused(
  data: { custom: CustomRule[]; disabled: DisabledDefault[] },
  change: () => unknown,
  message: string
) {
  const before = structuredClone(data);
  let error: unknown;
  try {
    change();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(RuleError);
  expect((error as Error).message).toBe(message);
  expect(data).toEqual(before);
}

const x = (n: number) => "x".repeat(n);

describe("addRule", () => {
  it("stores a custom rule and makes it active after the starter rules", () => {
    const { tables } = memoryTables();
    const rule = addRule(
      tables,
      { text: "Use the shared HTTP client", severity: "error" },
      NOW,
      () => "c_abc12345"
    );
    expect(rule).toEqual({
      id: "c_abc12345",
      text: "Use the shared HTTP client",
      severity: "error",
      createdAt: NOW
    });
    expect(readRules(tables).active.at(-1)).toMatchObject({
      id: "c_abc12345",
      source: "custom"
    });
  });

  it("stores the text trimmed, with whitespace collapsed to single spaces", () => {
    const { tables } = memoryTables();
    const rule = addRule(
      tables,
      { text: "  Use the\n shared   HTTP\tclient  ", severity: "warning" },
      NOW
    );
    expect(rule.text).toBe("Use the shared HTTP client");
  });

  it("gives new rules a c_ ID with 8 hex characters", () => {
    expect(newCustomRuleId()).toMatch(/^c_[0-9a-f]{8}$/);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "     "],
    ["9 characters", x(9)],
    ["10 characters once trimmed", `   ${x(9)}   `],
    ["201 characters", x(201)]
  ])("refuses text that is %s", (_case, text) => {
    const { tables, data } = memoryTables();
    expectRefused(
      data,
      () => addRule(tables, { text, severity: "error" }, NOW),
      "Rule text must be between 10 and 200 characters."
    );
  });

  it.each([10, 200])("accepts text of exactly %i characters", (n) => {
    const { tables } = memoryTables();
    expect(addRule(tables, { text: x(n), severity: "error" }, NOW).text).toBe(
      x(n)
    );
  });

  it("refuses a starter rule's text, ignoring case and whitespace", () => {
    const { tables, data } = memoryTables();
    expectRefused(
      data,
      () =>
        addRule(
          tables,
          { text: "  no SECRETS or api\n keys in CODE ", severity: "warning" },
          NOW
        ),
      "A rule with this text already exists."
    );
  });

  it("refuses a custom rule's text", () => {
    const { tables, data } = memoryTables([customRule(1)]);
    expectRefused(
      data,
      () =>
        addRule(
          tables,
          { text: "custom rule NUMBER 1", severity: "error" },
          NOW
        ),
      "A rule with this text already exists."
    );
  });

  it("accepts the text of a switched-off default (the override path)", () => {
    const { tables } = memoryTables([], [switchedOffRow("validate-input")]);
    const rule = addRule(
      tables,
      { text: "Validate external input at the boundary", severity: "warning" },
      NOW
    );
    expect(readRules(tables).active.map((r) => r.id)).toContain(rule.id);
  });

  it("refuses a 51st active rule", () => {
    const { tables, data } = memoryTables(fillToLimit());
    expect(readRules(tables).active).toHaveLength(50);
    expectRefused(
      data,
      () =>
        addRule(tables, { text: "One rule too many", severity: "error" }, NOW),
      "This workspace has 50 rules, the maximum. Remove one first."
    );
  });

  it("doesn't count switched-off defaults toward the limit", () => {
    const { tables } = memoryTables(
      fillToLimit(STARTER_PACK.length - 1).slice(1),
      [switchedOffRow("validate-input")]
    );
    expect(readRules(tables).active).toHaveLength(49);
    addRule(tables, { text: "The fiftieth rule", severity: "error" }, NOW);
    expect(readRules(tables).active).toHaveLength(50);
  });
});

describe("removeRule", () => {
  it("deletes a custom rule without asking for a reason", () => {
    const { tables, data } = memoryTables([customRule(1), customRule(2)]);
    const removal = removeRule(tables, { ruleId: customRule(1).id }, NOW);
    expect(removal).toMatchObject({
      kind: "deleted",
      rule: { id: "c_00000001" }
    });
    expect(data.custom.map((r) => r.id)).toEqual(["c_00000002"]);
  });

  it("switches off a recommended rule, recording the reason and the rule's text", () => {
    const { tables, data } = memoryTables();
    const removal = removeRule(
      tables,
      { ruleId: "no-console-log", reason: "  CLI tools\n print output  " },
      NOW
    );
    expect(removal).toMatchObject({
      kind: "switchedOff",
      reason: "CLI tools print output"
    });
    expect(data.disabled).toEqual([
      {
        ruleId: "no-console-log",
        reason: "CLI tools print output",
        ruleText: "No `console.log` left in production code",
        disabledAt: NOW
      }
    ]);
    expect(readRules(tables).active.map((r) => r.id)).not.toContain(
      "no-console-log"
    );
  });

  it.each(["no-secrets", "sql-parameterized"])(
    "refuses to switch off the locked rule %s, even with a reason",
    (ruleId) => {
      const { tables, data } = memoryTables();
      expectRefused(
        data,
        () => removeRule(tables, { ruleId, reason: "We need to" }, NOW),
        `Rule \`${ruleId}\` is locked and can't be switched off.`
      );
    }
  );

  it("refuses a locked rule that a stale row names as locked, not switched off", () => {
    const { tables, data } = memoryTables([], [switchedOffRow("no-secrets")]);
    expectRefused(
      data,
      () => removeRule(tables, { ruleId: "no-secrets", reason: "Again" }, NOW),
      "Rule `no-secrets` is locked and can't be switched off."
    );
  });

  it.each([
    ["an unknown ID", "no-such-rule"],
    ["the ID of a row no longer in the starter pack", "renamed-rule"]
  ])("refuses %s", (_case, ruleId) => {
    const { tables, data } = memoryTables([], [switchedOffRow("renamed-rule")]);
    expectRefused(
      data,
      () => removeRule(tables, { ruleId, reason: "Because" }, NOW),
      `No rule with ID \`${ruleId}\` exists in this workspace.`
    );
  });

  it.each([
    ["no reason", undefined],
    ["an empty reason", ""],
    ["a whitespace-only reason", "  \n "]
  ])("refuses to switch off a recommended rule with %s", (_case, reason) => {
    const { tables, data } = memoryTables();
    expectRefused(
      data,
      () => removeRule(tables, { ruleId: "validate-input", reason }, NOW),
      "A reason is required to switch off a recommended rule."
    );
  });

  it("refuses a reason over 200 characters", () => {
    const { tables, data } = memoryTables();
    expectRefused(
      data,
      () =>
        removeRule(tables, { ruleId: "validate-input", reason: x(201) }, NOW),
      "The reason must be at most 200 characters."
    );
  });

  it("accepts a reason of exactly 200 characters", () => {
    const { tables } = memoryTables();
    expect(
      removeRule(tables, { ruleId: "validate-input", reason: x(200) }, NOW)
    ).toMatchObject({ kind: "switchedOff" });
  });

  it("refuses a rule that is already switched off", () => {
    const { tables, data } = memoryTables(
      [],
      [switchedOffRow("validate-input")]
    );
    expectRefused(
      data,
      () =>
        removeRule(tables, { ruleId: "validate-input", reason: "Twice" }, NOW),
      "Rule `validate-input` is already switched off."
    );
  });
});

describe("restoreRule", () => {
  it("switches a recommended rule back on, in its starter-pack place", () => {
    const { tables, data } = memoryTables(
      [],
      [switchedOffRow("validate-input")]
    );
    expect(restoreRule(tables, { ruleId: "validate-input" })).toMatchObject({
      id: "validate-input"
    });
    expect(data.disabled).toEqual([]);
    expect(readRules(tables).active.map((r) => r.id)).toEqual(
      STARTER_PACK.map((r) => r.id)
    );
  });

  it.each([
    ["a recommended rule that is on", "validate-input"],
    ["a custom rule", "c_00000001"],
    ["a locked rule, even with a stale row", "no-secrets"]
  ])("refuses %s as not switched off", (_case, ruleId) => {
    const { tables, data } = memoryTables(
      [customRule(1)],
      [switchedOffRow("no-secrets")]
    );
    expectRefused(
      data,
      () => restoreRule(tables, { ruleId }),
      `Rule \`${ruleId}\` is not switched off.`
    );
  });

  it.each([
    ["an unknown ID", "no-such-rule"],
    ["the ID of a row no longer in the starter pack", "renamed-rule"]
  ])("refuses %s", (_case, ruleId) => {
    const { tables, data } = memoryTables([], [switchedOffRow("renamed-rule")]);
    expectRefused(
      data,
      () => restoreRule(tables, { ruleId }),
      `No rule with ID \`${ruleId}\` exists in this workspace.`
    );
  });

  it("refuses a rule whose text an active custom rule already has", () => {
    const { tables, data } = memoryTables(
      [customRule(1, { text: "validate external INPUT at the boundary" })],
      [switchedOffRow("validate-input")]
    );
    expectRefused(
      data,
      () => restoreRule(tables, { ruleId: "validate-input" }),
      "A rule with this text already exists."
    );
  });

  it("refuses to make a 51st active rule", () => {
    const { tables, data } = memoryTables(
      fillToLimit(STARTER_PACK.length - 1),
      [switchedOffRow("validate-input")]
    );
    expect(readRules(tables).active).toHaveLength(50);
    expectRefused(
      data,
      () => restoreRule(tables, { ruleId: "validate-input" }),
      "This workspace has 50 rules, the maximum. Remove one first."
    );
  });
});
