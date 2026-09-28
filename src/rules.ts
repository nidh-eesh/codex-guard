export type Severity = "error" | "warning";

export const RULE_TEXT_MIN_LENGTH = 10;
export const RULE_TEXT_MAX_LENGTH = 200;
/** Active rules in total, starter pack included (D5). */
export const MAX_ACTIVE_RULES = 50;
/** Custom rule IDs start with this, so they can't collide with starter IDs. */
export const CUSTOM_RULE_ID_PREFIX = "c_";
/** The prefix and 8 hex characters. */
export const CUSTOM_RULE_ID_LENGTH = CUSTOM_RULE_ID_PREFIX.length + 8;

/** A rule in the starter pack. `locked` exists only here (D7). */
export interface StarterRule {
  readonly id: string;
  readonly text: string;
  readonly severity: Severity;
  readonly locked: boolean;
}

/** A row of the `custom_rules` table. */
export interface CustomRule {
  id: string;
  text: string;
  severity: Severity;
  /** Milliseconds since the epoch. */
  createdAt: number;
}

/** A row of the `disabled_defaults` table: a switched-off starter rule. */
export interface DisabledDefault {
  ruleId: string;
  reason: string;
  /** The rule's text when it was switched off (D14). */
  ruleText: string;
  /** Milliseconds since the epoch. */
  disabledAt: number;
}

export interface ActiveRule {
  id: string;
  text: string;
  severity: Severity;
  locked: boolean;
  source: "starter" | "custom";
}

/** A starter rule the workspace has switched off: the exception record. */
export interface SwitchedOffRule {
  id: string;
  /** The rule's current text in the starter pack. */
  text: string;
  severity: Severity;
  reason: string;
  /**
   * The text the team switched off. Differs from `text` only after an edit
   * that didn't change the rule's meaning, and so kept its ID (D14).
   */
  textWhenSwitchedOff: string;
  disabledAt: number;
}

export interface ResolvedRules {
  active: ActiveRule[];
  switchedOff: SwitchedOffRule[];
}

/**
 * Give a rule a new ID whenever its meaning changes, wider or narrower
 * (D14): switched-off rows keep pointing at the old ID and stop applying.
 */
export const STARTER_PACK = [
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
] as const satisfies readonly StarterRule[];
