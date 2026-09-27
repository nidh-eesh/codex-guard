import { describe, expect, it } from "vitest";
import {
  CUSTOM_RULE_ID_PREFIX,
  MAX_ACTIVE_RULES,
  RULE_TEXT_MAX_LENGTH,
  RULE_TEXT_MIN_LENGTH,
  STARTER_PACK
} from "./rules";

describe("STARTER_PACK", () => {
  // An edit here is deliberate: a change of meaning needs a new ID (D14),
  // and DESIGN.md §3 changes in the same commit.
  it("matches the table in DESIGN.md §3", () => {
    expect(STARTER_PACK).toEqual([
      {
        id: "no-secrets",
        text: "No secrets or API keys in code",
        severity: "error",
        locked: true
      },
      {
        id: "sql-parameterized",
        text: "SQL queries must be parameterized",
        severity: "error",
        locked: true
      },
      {
        id: "validate-input",
        text: "Validate external input at the boundary",
        severity: "error",
        locked: false
      },
      {
        id: "no-sensitive-logs",
        text: "Don't log personal data or tokens",
        severity: "error",
        locked: false
      },
      {
        id: "explicit-errors",
        text: "Handle errors explicitly; no empty `catch` blocks",
        severity: "warning",
        locked: false
      },
      {
        id: "no-console-log",
        text: "No `console.log` left in production code",
        severity: "warning",
        locked: false
      }
    ]);
  });

  it("has unique IDs", () => {
    const ids = STARTER_PACK.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never uses the custom-rule ID prefix", () => {
    for (const rule of STARTER_PACK) {
      expect(rule.id.startsWith(CUSTOM_RULE_ID_PREFIX)).toBe(false);
    }
  });

  it("keeps every rule's text within the rule-text limits", () => {
    for (const rule of STARTER_PACK) {
      expect(rule.text.length).toBeGreaterThanOrEqual(RULE_TEXT_MIN_LENGTH);
      expect(rule.text.length).toBeLessThanOrEqual(RULE_TEXT_MAX_LENGTH);
    }
  });

  it("leaves room for custom rules under the active-rule limit", () => {
    expect(STARTER_PACK.length).toBeLessThan(MAX_ACTIVE_RULES);
  });
});
