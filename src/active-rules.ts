import type {
  CustomRule,
  DisabledDefault,
  ResolvedRules,
  StarterRule
} from "./rules";

/**
 * Active rules = starter pack − switched-off defaults + custom rules
 * (DESIGN.md §3).
 *
 * Author-owned (AGENTS.md): agents review and test this function; the
 * implementation is the author's.
 *
 * Contract:
 * - A `disabled` row switches off the starter rule with the same ID, unless
 *   that rule is locked. Locked rules are always active.
 * - A `disabled` row whose ID isn't in `starterPack` is ignored (D14).
 * - `active`: starter rules in `starterPack` order, then custom rules in the
 *   order given (callers pass them oldest first).
 * - `switchedOff`: one entry per starter rule that is switched off, in
 *   `starterPack` order.
 * - The inputs are not modified.
 *
 * Preconditions, guaranteed by the tables: at most one `disabled` row per
 * `ruleId` (primary key), and custom rule IDs start with `c_`.
 */
export function resolveRules(
  starterPack: readonly StarterRule[],
  disabled: readonly DisabledDefault[],
  custom: readonly CustomRule[]
): ResolvedRules {
  // TODO(author): implement. The `void`s only silence the unused-parameter
  // lint until then.
  void starterPack;
  void disabled;
  void custom;
  throw new Error("resolveRules is not implemented yet");
}
