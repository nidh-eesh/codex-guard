import { describe, expect, it } from "vitest";
import {
  addRule,
  argumentRefusal,
  newCustomRuleId,
  readRules,
  removeRule,
  restoreRule,
  RuleError,
  ruleChangeRefusal,
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
        `Rule \`${ruleId}\` is locked and can't be switched off. Locked rules can't be changed; don't try again.`
      );
    }
  );

  it("refuses a locked rule that a stale row names as locked, not switched off", () => {
    const { tables, data } = memoryTables([], [switchedOffRow("no-secrets")]);
    expectRefused(
      data,
      () => removeRule(tables, { ruleId: "no-secrets", reason: "Again" }, NOW),
      "Rule `no-secrets` is locked and can't be switched off. Locked rules can't be changed; don't try again."
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

  it.each([
    ["a made-up placeholder", "No reason"],
    ["a placeholder in other case and punctuation", "NOT NEEDED."],
    ["a placeholder the model might claim for the user", "User requested"],
    ["a reason under 10 characters", "Too noisy"]
  ])("refuses %s as a reason (D28)", (_case, reason) => {
    const { tables, data } = memoryTables();
    expectRefused(
      data,
      () => removeRule(tables, { ruleId: "validate-input", reason }, NOW),
      "The reason must say why the team is switching this rule off, in at least 10 characters."
    );
  });

  it("accepts a real reason of exactly 10 characters", () => {
    const { tables } = memoryTables();
    expect(
      removeRule(
        tables,
        { ruleId: "no-console-log", reason: "Too noisy!" },
        NOW
      )
    ).toMatchObject({ kind: "switchedOff", reason: "Too noisy!" });
  });

  it("accepts a reason that only starts like a placeholder", () => {
    const { tables } = memoryTables();
    const reason = "No reason to keep it: our logger replaces console.log";
    expect(
      removeRule(tables, { ruleId: "no-console-log", reason }, NOW)
    ).toMatchObject({ kind: "switchedOff", reason });
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
        removeRule(
          tables,
          { ruleId: "validate-input", reason: "Covered by our own linting" },
          NOW
        ),
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

  it("refuses a locked rule as locked, even with a stale row (D28)", () => {
    const { tables, data } = memoryTables([], [switchedOffRow("no-secrets")]);
    expectRefused(
      data,
      () => restoreRule(tables, { ruleId: "no-secrets" }),
      "Rule `no-secrets` is locked and always on. Locked rules can't be changed; don't try again."
    );
  });

  it.each([
    ["a recommended rule that is on", "validate-input"],
    ["a custom rule", "c_00000001"]
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

describe("ruleChangeRefusal: the approval card's warning (D28)", () => {
  // The card must warn exactly when execute would refuse, with its message
  const cases: [string, string, Record<string, unknown>][] = [
    [
      "removeRule",
      "a locked rule",
      { ruleId: "no-secrets", reason: "We need it off" }
    ],
    [
      "removeRule",
      "a rule already off",
      { ruleId: "validate-input", reason: "Covered elsewhere" }
    ],
    ["removeRule", "an unknown rule", { ruleId: "no-such-rule" }],
    [
      "removeRule",
      "a made-up reason",
      { ruleId: "no-console-log", reason: "No reason" }
    ],
    [
      "removeRule",
      "a real reason",
      { ruleId: "no-console-log", reason: "Our logger replaces it" }
    ],
    ["restoreRule", "a rule that's on", { ruleId: "no-console-log" }],
    ["restoreRule", "a rule that's off", { ruleId: "validate-input" }],
    ["addRule", "text too short", { text: "Short", severity: "warning" }],
    [
      "addRule",
      "a duplicate",
      { text: "Validate external input at the boundary", severity: "error" }
    ],
    [
      "addRule",
      "a new rule",
      { text: "Use the shared HTTP client", severity: "warning" }
    ]
  ];

  it.each(cases)(
    "%s on %s: warns exactly when execute refuses",
    (tool, _case, input) => {
      const { tables } = memoryTables([], [switchedOffRow("validate-input")]);
      const warning = ruleChangeRefusal(tool, input, readRules(tables));
      let refused: string | undefined;
      try {
        if (tool === "addRule") {
          addRule(tables, input as { text: string; severity: "warning" }, NOW);
        } else if (tool === "removeRule") {
          removeRule(tables, input as { ruleId: string; reason?: string }, NOW);
        } else {
          restoreRule(tables, input as { ruleId: string });
        }
      } catch (error) {
        refused = (error as Error).message;
      }
      expect(warning).toBe(refused);
    }
  );

  it("gives no warning for a tool that doesn't change rules", () => {
    const { tables } = memoryTables();
    expect(
      ruleChangeRefusal("listRules", {}, readRules(tables))
    ).toBeUndefined();
  });
});

describe("argumentRefusal: refused without approval (D28)", () => {
  // Refusals that can't depend on the rules in SQLite
  const refused: [string, string, Record<string, unknown>, string][] = [
    [
      "removeRule",
      "a locked rule",
      { ruleId: "no-secrets", reason: "Covered by our own linting" },
      "Rule `no-secrets` is locked and can't be switched off. Locked rules can't be changed; don't try again."
    ],
    [
      "restoreRule",
      "a locked rule",
      { ruleId: "sql-parameterized" },
      "Rule `sql-parameterized` is locked and always on. Locked rules can't be changed; don't try again."
    ],
    [
      "removeRule",
      "a recommended rule with no reason",
      { ruleId: "validate-input" },
      "A reason is required to switch off a recommended rule."
    ],
    [
      "removeRule",
      "a recommended rule with a placeholder reason",
      { ruleId: "validate-input", reason: "No reason" },
      "The reason must say why the team is switching this rule off, in at least 10 characters."
    ],
    [
      "removeRule",
      "a recommended rule with a reason over 200 characters",
      { ruleId: "validate-input", reason: x(201) },
      "The reason must be at most 200 characters."
    ],
    [
      "addRule",
      "text under 10 characters",
      { text: "Short", severity: "warning" },
      "Rule text must be between 10 and 200 characters."
    ],
    [
      "addRule",
      "text over 200 characters",
      { text: x(201), severity: "warning" },
      "Rule text must be between 10 and 200 characters."
    ]
  ];

  it.each(refused)(
    "%s on %s: refused whatever the rules are",
    (tool, _case, input, message) => {
      expect(argumentRefusal(tool, input)?.message).toBe(message);
      // execute gives the same refusal with the rule on or off
      for (const off of [[], ["validate-input"]]) {
        const { tables, data } = memoryTables(
          [],
          off.map((ruleId) => switchedOffRow(ruleId))
        );
        const change =
          tool === "addRule"
            ? () =>
                addRule(
                  tables,
                  input as { text: string; severity: "warning" },
                  NOW
                )
            : tool === "removeRule"
              ? () =>
                  removeRule(
                    tables,
                    input as { ruleId: string; reason?: string },
                    NOW
                  )
              : () => restoreRule(tables, input as { ruleId: string });
        expectRefused(data, change, message);
      }
    }
  );

  it.each([
    [
      "removeRule",
      "a recommended rule with a real reason",
      { ruleId: "validate-input", reason: "Covered by our own linting" }
    ],
    ["removeRule", "a custom rule with no reason", { ruleId: "c_00000001" }],
    ["removeRule", "an unknown rule", { ruleId: "no-such-rule" }],
    [
      "removeRule",
      "a locked rule's ID in other case",
      { ruleId: "NO-SECRETS" }
    ],
    ["restoreRule", "an unlocked rule", { ruleId: "validate-input" }],
    [
      "addRule",
      "text of a valid length",
      { text: "Use the shared HTTP client", severity: "warning" }
    ]
  ])(
    "%s on %s: waits for approval, since the outcome depends on the rules",
    (tool, _case, input) => {
      expect(argumentRefusal(tool, input)).toBeUndefined();
    }
  );
});
