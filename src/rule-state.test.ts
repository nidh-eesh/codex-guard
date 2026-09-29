import { describe, expect, it } from "vitest";
import type { BudgetMeter } from "./budget-meter";
import {
  INITIAL_STATE,
  rejectBrowserStateWrites,
  withBudget,
  withRules,
  type WorkspaceState
} from "./rule-state";
import type { ResolvedRules } from "./rules";

const rules: ResolvedRules = {
  active: [
    {
      id: "no-secrets",
      text: "No secrets or API keys in code",
      severity: "error",
      locked: true,
      source: "starter"
    }
  ],
  switchedOff: []
};
const meter: BudgetMeter = { day: "2026-09-29", reviews: 94, chat: 100 };

describe("workspace state", () => {
  it("starts with no rules and no meter", () => {
    expect(INITIAL_STATE).toEqual({
      active: [],
      switchedOff: [],
      budget: null
    });
  });

  it("keeps the meter when the rules change", () => {
    const state = withBudget(INITIAL_STATE, meter);
    expect(withRules(state, rules)).toEqual({ ...rules, budget: meter });
  });

  it("keeps the rules when the meter changes", () => {
    const state = withRules(INITIAL_STATE, rules);
    expect(withBudget(state, meter)).toEqual({ ...rules, budget: meter });
  });

  it("starts the meter as null in state saved before it existed", () => {
    const saved = { active: [], switchedOff: [] } as unknown as WorkspaceState;
    expect(withRules(saved, rules).budget).toBeNull();
  });
});

describe("rejectBrowserStateWrites", () => {
  it("lets the server write state", () => {
    expect(() => rejectBrowserStateWrites("server")).not.toThrow();
  });

  it("rejects a write from a browser connection", () => {
    const connection = { id: "conn-1" };
    expect(() => rejectBrowserStateWrites(connection)).toThrow(
      "Rules state is written only by the server."
    );
  });
});
