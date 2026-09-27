import type {
  ActiveRule,
  CustomRule,
  DisabledDefault,
  ResolvedRules,
  StarterRule,
  SwitchedOffRule
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
 * - A custom rule whose ID matches a starter ID is dropped: the starter rule
 *   wins. addRule can't create one (custom IDs start with `c_`); this guards
 *   against bad rows.
 * - The inputs are not modified.
 *
 * Precondition, guaranteed by the table's primary key: at most one
 * `disabled` row per `ruleId`.
 */
export function resolveRules(
  starterPack: readonly StarterRule[],
  disabled: readonly DisabledDefault[],
  custom: readonly CustomRule[]
): ResolvedRules {
  const disabledMap = new Map(disabled.map((d) => [d.ruleId, d]));
  const starterIds = new Set(starterPack.map((s) => s.id));
  const active: ActiveRule[] = [];
  const switchedOff: SwitchedOffRule[] = [];
  for (const starter of starterPack) {
    const row = disabledMap.get(starter.id);
    if (row && !starter.locked) {
      switchedOff.push({
        id: starter.id,
        text: starter.text,
        severity: starter.severity,
        reason: row.reason,
        textWhenSwitchedOff: row.ruleText,
        disabledAt: row.disabledAt
      });
    } else {
      active.push({
        id: starter.id,
        text: starter.text,
        severity: starter.severity,
        locked: starter.locked,
        source: "starter"
      });
    }
  }

  for (const rule of custom) {
    if (!starterIds.has(rule.id)) {
      active.push({
        id: rule.id,
        text: rule.text,
        severity: rule.severity,
        locked: false,
        source: "custom"
      });
    }
  }

  return { active, switchedOff };
}
