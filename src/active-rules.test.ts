import { describe, expect, it } from "vitest";
import { resolveRules } from "./active-rules";
import {
  STARTER_PACK,
  type CustomRule,
  type DisabledDefault,
  type StarterRule
} from "./rules";

// A small pack keeps these tests independent of edits to STARTER_PACK
const PACK: readonly StarterRule[] = [
  { id: "locked-a", text: "Locked rule A", severity: "error", locked: true },
  { id: "open-b", text: "Unlocked rule B", severity: "error", locked: false },
  { id: "open-c", text: "Unlocked rule C", severity: "warning", locked: false }
];

function off(
  ruleId: string,
  fields: Partial<DisabledDefault> = {}
): DisabledDefault {
  const text = PACK.find((rule) => rule.id === ruleId)?.text ?? "Old text";
  return {
    ruleId,
    reason: `Reason for ${ruleId}`,
    ruleText: text,
    disabledAt: 1_000,
    ...fields
  };
}

function custom(id: string, fields: Partial<CustomRule> = {}): CustomRule {
  return {
    id,
    text: `Custom rule ${id}`,
    severity: "warning",
    createdAt: 2_000,
    ...fields
  };
}

const ids = (rules: readonly { id: string }[]) => rules.map((rule) => rule.id);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Every subset of `items`, including the empty one. */
function subsets<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask++) {
    result.push(items.filter((_, i) => mask & (1 << i)));
  }
  return result;
}

describe("resolveRules", () => {
  describe("with no workspace changes", () => {
    it("returns every starter rule, in starter-pack order", () => {
      expect(resolveRules(PACK, [], [])).toEqual({
        active: [
          {
            id: "locked-a",
            text: "Locked rule A",
            severity: "error",
            locked: true,
            source: "starter"
          },
          {
            id: "open-b",
            text: "Unlocked rule B",
            severity: "error",
            locked: false,
            source: "starter"
          },
          {
            id: "open-c",
            text: "Unlocked rule C",
            severity: "warning",
            locked: false,
            source: "starter"
          }
        ],
        switchedOff: []
      });
    });

    it("works on the real starter pack", () => {
      const { active, switchedOff } = resolveRules(STARTER_PACK, [], []);
      expect(ids(active)).toEqual(ids(STARTER_PACK));
      expect(switchedOff).toEqual([]);
    });
  });

  describe("switched-off defaults", () => {
    it("removes a switched-off default from the active rules", () => {
      const { active } = resolveRules(PACK, [off("open-b")], []);
      expect(ids(active)).toEqual(["locked-a", "open-c"]);
    });

    it("records the current rule and what the team agreed to", () => {
      const row = off("open-c", {
        reason: "Scripts in this repo print to stdout",
        disabledAt: 1_234
      });
      expect(resolveRules(PACK, [row], []).switchedOff).toEqual([
        {
          id: "open-c",
          text: "Unlocked rule C",
          severity: "warning",
          reason: "Scripts in this repo print to stdout",
          textWhenSwitchedOff: "Unlocked rule C",
          disabledAt: 1_234
        }
      ]);
    });

    it("keeps a locked rule active even when a row names it", () => {
      const { active, switchedOff } = resolveRules(PACK, [off("locked-a")], []);
      expect(ids(active)).toEqual(["locked-a", "open-b", "open-c"]);
      expect(switchedOff).toEqual([]);
    });

    it("ignores a row whose ID is no longer in the starter pack (D14)", () => {
      const { active, switchedOff } = resolveRules(
        PACK,
        [off("renamed-rule")],
        []
      );
      expect(ids(active)).toEqual(ids(PACK));
      expect(switchedOff).toEqual([]);
    });

    it("stays switched off after an edit that kept the ID, reporting both texts", () => {
      const row = off("open-b", { ruleText: "Unlockd rule B" });
      const { active, switchedOff } = resolveRules(PACK, [row], []);
      expect(ids(active)).not.toContain("open-b");
      expect(switchedOff).toMatchObject([
        {
          id: "open-b",
          text: "Unlocked rule B",
          textWhenSwitchedOff: "Unlockd rule B"
        }
      ]);
    });

    it("lists switched-off rules in starter-pack order, not row order", () => {
      const rows = [
        off("open-c", { disabledAt: 1 }),
        off("open-b", { disabledAt: 2 })
      ];
      expect(ids(resolveRules(PACK, rows, []).switchedOff)).toEqual([
        "open-b",
        "open-c"
      ]);
    });
  });

  describe("custom rules", () => {
    it("adds custom rules after the starter rules, in the order given", () => {
      const { active } = resolveRules(
        PACK,
        [],
        [custom("c_2", { createdAt: 5 }), custom("c_1", { createdAt: 9 })]
      );
      expect(ids(active)).toEqual([
        "locked-a",
        "open-b",
        "open-c",
        "c_2",
        "c_1"
      ]);
    });

    it("keeps each custom rule's text and severity; custom rules are never locked", () => {
      const rule = custom("c_1", {
        text: "Use the shared HTTP client",
        severity: "error"
      });
      expect(resolveRules(PACK, [], [rule]).active.at(-1)).toEqual({
        id: "c_1",
        text: "Use the shared HTTP client",
        severity: "error",
        locked: false,
        source: "custom"
      });
    });

    it("keeps a custom rule with the text of a switched-off default (the override path)", () => {
      const { active } = resolveRules(
        PACK,
        [off("open-b")],
        [custom("c_1", { text: "Unlocked rule B" })]
      );
      expect(ids(active)).toEqual(["locked-a", "open-c", "c_1"]);
    });

    it("drops a custom rule whose ID matches a starter ID; the starter rule wins", () => {
      // addRule can't create one (custom IDs start with c_), but a bad row
      // must not weaken a locked rule
      const shadow = custom("locked-a", {
        text: "Keys in test fixtures are allowed",
        severity: "warning"
      });
      const { active } = resolveRules(PACK, [], [shadow, custom("c_1")]);
      expect(ids(active)).toEqual(["locked-a", "open-b", "open-c", "c_1"]);
      expect(active[0]).toEqual({
        id: "locked-a",
        text: "Locked rule A",
        severity: "error",
        locked: true,
        source: "starter"
      });
    });
  });

  describe("invariants, for every combination of switched-off rows", () => {
    const rowSets = subsets([
      ...STARTER_PACK.map((rule) => off(rule.id, { ruleText: rule.text })),
      off("renamed-rule")
    ]);

    it("keeps every locked rule active", () => {
      for (const rows of rowSets) {
        const active = ids(resolveRules(STARTER_PACK, rows, []).active);
        for (const rule of STARTER_PACK.filter((r) => r.locked)) {
          expect(active).toContain(rule.id);
        }
      }
    });

    it("puts every starter rule in exactly one of active and switchedOff", () => {
      for (const rows of rowSets) {
        const { active, switchedOff } = resolveRules(STARTER_PACK, rows, []);
        expect([...ids(active), ...ids(switchedOff)].sort()).toEqual(
          ids(STARTER_PACK).sort()
        );
      }
    });
  });

  it("doesn't modify its inputs", () => {
    const pack = deepFreeze(structuredClone([...PACK]));
    const rows = deepFreeze([off("open-c"), off("open-b")]);
    const customs = deepFreeze([custom("c_2"), custom("c_1")]);
    const copies = structuredClone({ pack, rows, customs });

    resolveRules(pack, rows, customs);

    expect({ pack, rows, customs }).toEqual(copies);
  });

  // Trace this one by hand before running it
  it("resolves a full example", () => {
    const result = resolveRules(
      PACK,
      [
        off("renamed-rule", { reason: "Stale row" }),
        off("locked-a", { reason: "Tried to switch off a locked rule" }),
        off("open-b", { reason: "Covered by our API gateway", disabledAt: 7 })
      ],
      [
        custom("c_1", {
          text: "Use the shared HTTP client",
          severity: "error"
        }),
        custom("c_2", { text: "Prefer early returns" })
      ]
    );

    expect(result).toEqual({
      active: [
        {
          id: "locked-a",
          text: "Locked rule A",
          severity: "error",
          locked: true,
          source: "starter"
        },
        {
          id: "open-c",
          text: "Unlocked rule C",
          severity: "warning",
          locked: false,
          source: "starter"
        },
        {
          id: "c_1",
          text: "Use the shared HTTP client",
          severity: "error",
          locked: false,
          source: "custom"
        },
        {
          id: "c_2",
          text: "Prefer early returns",
          severity: "warning",
          locked: false,
          source: "custom"
        }
      ],
      switchedOff: [
        {
          id: "open-b",
          text: "Unlocked rule B",
          severity: "error",
          reason: "Covered by our API gateway",
          textWhenSwitchedOff: "Unlocked rule B",
          disabledAt: 7
        }
      ]
    });
  });
});
