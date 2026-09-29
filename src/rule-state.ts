import type { BudgetMeter } from "./budget-meter";
import type { ResolvedRules } from "./rules";

/** Agent state: the workspace's rules, and the shared budget meter. */
export interface WorkspaceState extends ResolvedRules {
  budget: BudgetMeter | null;
}

/** Agent state before the rules are first read and the meter first pushed. */
export const INITIAL_STATE: WorkspaceState = {
  active: [],
  switchedOff: [],
  budget: null
};

/**
 * New rules, keeping the meter. State saved before the meter existed has
 * no `budget`, so it starts as null.
 */
export function withRules(
  state: WorkspaceState,
  rules: ResolvedRules
): WorkspaceState {
  return { ...rules, budget: state.budget ?? null };
}

/** A new meter, keeping the rules. */
export function withBudget(
  state: WorkspaceState,
  budget: BudgetMeter
): WorkspaceState {
  return { ...state, budget };
}

/**
 * Browsers receive the rules as agent state but never write it (DESIGN.md
 * §7, layer 6); the SDK calls this before it saves or broadcasts any change.
 * The SDK logs the error, so its message names no workspace data.
 */
export function rejectBrowserStateWrites(source: "server" | object): void {
  if (source !== "server") {
    throw new Error("Rules state is written only by the server.");
  }
}
