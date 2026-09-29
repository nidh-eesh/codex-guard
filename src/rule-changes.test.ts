import { describe, expect, it } from "vitest";
import {
  addRule,
  callRefusal,
  newCustomRuleId,
  readRules,
  refusedOnCallAlone,
  removeRule,
  removeRules,
  restoreRule,
  restoreRules,
  RuleError,
  ruleChangePreview,
  ruleIdsOf,
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

const LOCKED_REFUSAL =
  "Rule `no-secrets` is locked and can't be switched off. Locked rules can't be changed; don't try again.";
const UNQUOTED_REFUSAL =
  "The reason must be in the user's own words, and it isn't in their recent messages. Ask the user why the team is switching this rule off.";
const REASON = "Covered by our own linting";
const SAID = [`Switch those off please, ${REASON.toLowerCase()}.`];

describe("ruleIdsOf", () => {
  it("reads each rule once, and skips anything that isn't a string", () => {
    expect(ruleIdsOf({ ruleIds: ["a", "b", "a", 7] })).toEqual(["a", "b"]);
  });

  it("reads a call from before the tools took lists as a list of one", () => {
    expect(ruleIdsOf({ ruleId: "no-secrets" })).toEqual(["no-secrets"]);
    expect(ruleIdsOf({})).toEqual([]);
    expect(ruleIdsOf(null)).toEqual([]);
  });
});

describe("quoted reasons (D28)", () => {
  it("refuses a reason the user never wrote: the local incident", () => {
    // The model invented this reason, and a person approved it 4 times
    const invented = "This rule is not necessary for our project";
    expect(
      callRefusal("removeRule", "validate-input", invented, [
        "Disable all rules"
      ])?.message
    ).toBe(UNQUOTED_REFUSAL);
  });

  it("accepts the user's words anywhere in a message, ignoring case and spacing", () => {
    const said = ["Switch off console log.  We   use OUR own logger instead"];
    expect(
      callRefusal("removeRule", "no-console-log", "we use our own logger", said)
    ).toBeUndefined();
  });

  it("checks the other reason rules first", () => {
    expect(
      callRefusal("removeRule", "validate-input", undefined, [])?.message
    ).toBe("A reason is required to switch off a recommended rule.");
    expect(
      callRefusal("removeRule", "validate-input", "No reason", ["No reason"])
        ?.message
    ).toBe(
      "The reason must say why the team is switching this rule off, in at least 10 characters."
    );
  });

  it("asks nothing of custom rules, or of restoring", () => {
    expect(
      callRefusal("removeRule", "c_00000001", undefined, [])
    ).toBeUndefined();
    expect(
      callRefusal("restoreRule", "validate-input", undefined, [])
    ).toBeUndefined();
  });

  it("refuses an ID no rule could have, whatever the reason (D28)", () => {
    // Seen live: the model named the rule "all"
    for (const ruleId of ["all", "NO-SECRETS", "c_notahexid"]) {
      expect(callRefusal("removeRule", ruleId, REASON, SAID)?.message).toBe(
        `No rule with ID \`${ruleId}\` exists in this workspace.`
      );
      expect(callRefusal("restoreRule", ruleId, undefined, [])?.message).toBe(
        `No rule with ID \`${ruleId}\` exists in this workspace.`
      );
    }
  });
});

describe("refusedOnCallAlone: no approval needed to refuse (D28)", () => {
  it.each([
    [
      "removeRule",
      "locked rules only",
      { ruleIds: ["no-secrets", "sql-parameterized"], reason: REASON },
      SAID
    ],
    [
      "removeRule",
      "a reason the user didn't write",
      { ruleIds: ["validate-input"], reason: REASON },
      ["Disable all rules"]
    ],
    [
      "removeRule",
      "a locked rule and an unquoted reason",
      { ruleIds: ["no-secrets", "validate-input"], reason: REASON },
      []
    ],
    ["restoreRule", "a locked rule", { ruleIds: ["no-secrets"] }, []],
    [
      "removeRule",
      "an ID no rule could have",
      { ruleIds: ["all"], reason: "No reason provided" },
      []
    ],
    [
      "addRule",
      "text under 10 characters",
      { text: "Short", severity: "warning" },
      []
    ]
  ] as const)("%s with %s: refused at once", (tool, _case, input, said) => {
    expect(refusedOnCallAlone(tool, input, said)).toBe(true);
  });

  it.each([
    [
      "removeRule",
      "one quoted switch-off among locked rules",
      { ruleIds: ["no-secrets", "validate-input"], reason: REASON },
      SAID
    ],
    ["removeRule", "a custom rule", { ruleIds: ["c_00000001"] }, []],
    [
      "removeRule",
      "a custom-shaped ID that may exist",
      { ruleIds: ["c_99999999"] },
      []
    ],
    ["restoreRule", "an unlocked rule", { ruleIds: ["validate-input"] }, []],
    [
      "addRule",
      "text of a valid length",
      { text: "Use the shared HTTP client", severity: "warning" },
      []
    ]
  ] as const)("%s with %s: waits for approval", (tool, _case, input, said) => {
    expect(refusedOnCallAlone(tool, input, said)).toBe(false);
  });

  it.each([
    [
      "a locked rule",
      { ruleIds: ["no-secrets"], reason: REASON },
      SAID,
      LOCKED_REFUSAL
    ],
    [
      "an unquoted reason",
      { ruleIds: ["validate-input"], reason: REASON },
      [],
      UNQUOTED_REFUSAL
    ],
    [
      "a placeholder reason",
      { ruleIds: ["validate-input"], reason: "Not needed" },
      ["Not needed"],
      "The reason must say why the team is switching this rule off, in at least 10 characters."
    ]
  ])(
    "execute refuses %s the same way with the rule on or off",
    (_case, input, said, message) => {
      for (const off of [[], ["validate-input"]]) {
        const { tables, data } = memoryTables(
          [],
          off.map((ruleId) => switchedOffRow(ruleId))
        );
        expectRefused(
          data,
          () => removeRules(tables, input, NOW, said),
          message
        );
      }
    }
  );
});

describe("removeRules and restoreRules: one call for many rules (D29)", () => {
  it("applies what it can and reports each rule it refused", () => {
    const { tables } = memoryTables([customRule(1)]);
    const report = removeRules(
      tables,
      {
        ruleIds: [
          "validate-input",
          "no-console-log",
          "no-secrets",
          "c_00000001",
          "no-such-rule"
        ],
        reason: REASON
      },
      NOW,
      SAID
    );
    expect(report).toEqual({
      switchedOff: ["validate-input", "no-console-log"],
      deleted: ["c_00000001"],
      reason: REASON,
      refused: [
        { ruleId: "no-secrets", message: LOCKED_REFUSAL },
        {
          ruleId: "no-such-rule",
          message: "No rule with ID `no-such-rule` exists in this workspace."
        }
      ],
      rules: {
        active: [
          "no-secrets",
          "sql-parameterized",
          "no-sensitive-logs",
          "explicit-errors"
        ],
        switchedOff: ["validate-input", "no-console-log"]
      }
    });
  });

  it("changes a rule named twice once", () => {
    const { tables } = memoryTables();
    const report = removeRules(
      tables,
      { ruleIds: ["validate-input", "validate-input"], reason: REASON },
      NOW,
      SAID
    );
    expect(report.switchedOff).toEqual(["validate-input"]);
    expect(report.refused).toEqual([]);
  });

  it("fails with every refusal, and changes nothing, when no rule can change", () => {
    const { tables, data } = memoryTables(
      [],
      [switchedOffRow("validate-input")]
    );
    expectRefused(
      data,
      () =>
        removeRules(
          tables,
          { ruleIds: ["no-secrets", "validate-input"], reason: REASON },
          NOW,
          SAID
        ),
      `${LOCKED_REFUSAL} Rule \`validate-input\` is already switched off.`
    );
  });

  it("says each distinct refusal once", () => {
    const { tables, data } = memoryTables();
    expectRefused(
      data,
      () =>
        removeRules(
          tables,
          {
            ruleIds: ["no-secrets", "validate-input", "no-console-log"],
            reason: "The team wants to disable all rules"
          },
          NOW,
          ["Disable all rules"]
        ),
      `${LOCKED_REFUSAL} ${UNQUOTED_REFUSAL}`
    );
  });

  it("refuses a call that names no rule", () => {
    const { tables, data } = memoryTables();
    expectRefused(
      data,
      () => removeRules(tables, { ruleIds: [] }, NOW, SAID),
      "Name at least one rule to change."
    );
  });

  it("reads a call still pending from before the tools took lists", () => {
    const { tables } = memoryTables();
    const legacy = { ruleId: "no-console-log", reason: REASON } as unknown as {
      ruleIds: string[];
      reason: string;
    };
    expect(removeRules(tables, legacy, NOW, SAID).switchedOff).toEqual([
      "no-console-log"
    ]);
  });

  it("restores in order, each against the rules the earlier ones left", () => {
    // 49 active rules: the first restore makes 50, so the second is refused
    const { tables } = memoryTables(fillToLimit(STARTER_PACK.length - 1), [
      switchedOffRow("validate-input"),
      switchedOffRow("no-console-log")
    ]);
    const report = restoreRules(tables, {
      ruleIds: ["validate-input", "no-console-log"]
    });
    expect(report.restored).toEqual(["validate-input"]);
    expect(report.refused).toEqual([
      {
        ruleId: "no-console-log",
        message: "This workspace has 50 rules, the maximum. Remove one first."
      }
    ]);
    expect(report.rules.switchedOff).toEqual(["no-console-log"]);
  });
});

describe("ruleChangePreview: the approval card (D28, D29)", () => {
  // For one rule, the card must warn exactly when the change is refused
  const cases: [string, string, Record<string, unknown>][] = [
    [
      "removeRule",
      "a rule already off",
      { ruleIds: ["validate-input"], reason: REASON }
    ],
    ["removeRule", "an unknown rule", { ruleIds: ["no-such-rule"] }],
    [
      "removeRule",
      "a recommended rule",
      { ruleIds: ["no-console-log"], reason: REASON }
    ],
    ["restoreRule", "a rule that's on", { ruleIds: ["no-console-log"] }],
    ["restoreRule", "a rule that's off", { ruleIds: ["validate-input"] }],
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
      const preview = ruleChangePreview(tool, input, readRules(tables));
      let refused: string | undefined;
      try {
        if (tool === "addRule") {
          addRule(tables, input as { text: string; severity: "warning" }, NOW);
        } else if (tool === "removeRule") {
          removeRules(
            tables,
            input as { ruleIds: string[]; reason?: string },
            NOW,
            SAID
          );
        } else {
          restoreRules(tables, input as { ruleIds: string[] });
        }
      } catch (error) {
        refused = (error as Error).message;
      }
      expect(preview.refusals).toEqual(refused ? [refused] : []);
      expect(preview.allRefused).toBe(refused !== undefined);
    }
  );

  it("lists each refused rule in a batch, and disables Approve only when none can change", () => {
    const { tables } = memoryTables([], [switchedOffRow("validate-input")]);
    const rules = readRules(tables);
    const mixed = ruleChangePreview(
      "removeRule",
      { ruleIds: ["validate-input", "no-console-log"], reason: REASON },
      rules
    );
    expect(mixed).toEqual({
      refusals: ["Rule `validate-input` is already switched off."],
      allRefused: false
    });
    const none = ruleChangePreview(
      "removeRule",
      { ruleIds: ["validate-input", "no-secrets"], reason: REASON },
      rules
    );
    expect(none.allRefused).toBe(true);
    expect(none.refusals).toHaveLength(2);
  });

  it("previews a call still pending from before the tools took lists", () => {
    const { tables } = memoryTables();
    expect(
      ruleChangePreview(
        "removeRule",
        { ruleId: "no-secrets", reason: "No reason" },
        readRules(tables)
      )
    ).toEqual({ refusals: [LOCKED_REFUSAL], allRefused: true });
  });

  it("previews nothing for a tool that doesn't change rules", () => {
    const { tables } = memoryTables();
    expect(ruleChangePreview("listRules", {}, readRules(tables))).toEqual({
      refusals: [],
      allRefused: false
    });
  });
});
