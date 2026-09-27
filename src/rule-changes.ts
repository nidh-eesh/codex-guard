import { resolveRules } from "./active-rules";
import {
  CUSTOM_RULE_ID_PREFIX,
  MAX_ACTIVE_RULES,
  RULE_TEXT_MAX_LENGTH,
  RULE_TEXT_MIN_LENGTH,
  STARTER_PACK,
  type ActiveRule,
  type CustomRule,
  type DisabledDefault,
  type ResolvedRules,
  type Severity,
  type SwitchedOffRule
} from "./rules";

export const REASON_MAX_LENGTH = 200;

/**
 * A rule change refused for a reason the user should see. Its message is
 * shown as is (DESIGN.md §5); any other error is shown as a generic one.
 */
export class RuleError extends Error {}

const refuse = {
  textLength: () =>
    new RuleError(
      `Rule text must be between ${RULE_TEXT_MIN_LENGTH} and ${RULE_TEXT_MAX_LENGTH} characters.`
    ),
  duplicate: () => new RuleError("A rule with this text already exists."),
  full: () =>
    new RuleError(
      `This workspace has ${MAX_ACTIVE_RULES} rules, the maximum. Remove one first.`
    ),
  unknown: (id: string) =>
    new RuleError(`No rule with ID \`${id}\` exists in this workspace.`),
  locked: (id: string) =>
    new RuleError(`Rule \`${id}\` is locked and can't be switched off.`),
  noReason: () =>
    new RuleError("A reason is required to switch off a recommended rule."),
  reasonLength: () =>
    new RuleError(
      `The reason must be at most ${REASON_MAX_LENGTH} characters.`
    ),
  alreadyOff: (id: string) =>
    new RuleError(`Rule \`${id}\` is already switched off.`),
  notOff: (id: string) => new RuleError(`Rule \`${id}\` is not switched off.`)
};

/**
 * The workspace's rule tables (DESIGN.md §3). The agent implements this with
 * SQLite; the tests use arrays.
 */
export interface RuleTables {
  /** Oldest first. */
  customRules(): CustomRule[];
  disabledDefaults(): DisabledDefault[];
  insertCustomRule(rule: CustomRule): void;
  deleteCustomRule(id: string): void;
  insertDisabledDefault(row: DisabledDefault): void;
  deleteDisabledDefault(ruleId: string): void;
}

export function readRules(tables: RuleTables): ResolvedRules {
  return resolveRules(
    STARTER_PACK,
    tables.disabledDefaults(),
    tables.customRules()
  );
}

/**
 * Stored form of free text: trimmed, and every run of whitespace, newlines
 * included, collapsed to one space. Rules and reasons stay on one line in
 * prompts and in the UI.
 */
function clean(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** Duplicates are compared after trimming, collapsing whitespace and lowercasing. */
function duplicateKey(text: string): string {
  return clean(text).toLowerCase();
}

function hasText(rules: readonly ActiveRule[], text: string): boolean {
  const key = duplicateKey(text);
  return rules.some((rule) => duplicateKey(rule.text) === key);
}

export function newCustomRuleId(): string {
  return `${CUSTOM_RULE_ID_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
}

// Each change reads, checks and writes without awaiting in between. A Durable
// Object runs one such block at a time, so two changes can't interleave.

export function addRule(
  tables: RuleTables,
  input: { text: string; severity: Severity },
  now: number,
  newId: () => string = newCustomRuleId
): CustomRule {
  const text = clean(input.text);
  if (
    text.length < RULE_TEXT_MIN_LENGTH ||
    text.length > RULE_TEXT_MAX_LENGTH
  ) {
    throw refuse.textLength();
  }
  const { active } = readRules(tables);
  if (hasText(active, text)) throw refuse.duplicate();
  if (active.length >= MAX_ACTIVE_RULES) throw refuse.full();

  const rule: CustomRule = {
    id: newId(),
    text,
    severity: input.severity,
    createdAt: now
  };
  tables.insertCustomRule(rule);
  return rule;
}

export type Removal =
  | { kind: "deleted"; rule: ActiveRule }
  | { kind: "switchedOff"; rule: ActiveRule; reason: string };

/** Deletes a custom rule, or switches off a recommended default. */
export function removeRule(
  tables: RuleTables,
  input: { ruleId: string; reason?: string },
  now: number
): Removal {
  const { ruleId } = input;
  const { active, switchedOff } = readRules(tables);
  if (switchedOff.some((rule) => rule.id === ruleId)) {
    throw refuse.alreadyOff(ruleId);
  }
  const rule = active.find((candidate) => candidate.id === ruleId);
  if (!rule) throw refuse.unknown(ruleId);
  if (rule.locked) throw refuse.locked(ruleId);

  if (rule.source === "custom") {
    tables.deleteCustomRule(ruleId);
    return { kind: "deleted", rule };
  }

  const reason = clean(input.reason ?? "");
  if (!reason) throw refuse.noReason();
  if (reason.length > REASON_MAX_LENGTH) throw refuse.reasonLength();
  tables.insertDisabledDefault({
    ruleId,
    reason,
    ruleText: rule.text,
    disabledAt: now
  });
  return { kind: "switchedOff", rule, reason };
}

/** Switches a recommended default back on. */
export function restoreRule(
  tables: RuleTables,
  input: { ruleId: string }
): SwitchedOffRule {
  const { ruleId } = input;
  const { active, switchedOff } = readRules(tables);
  const rule = switchedOff.find((candidate) => candidate.id === ruleId);
  if (!rule) {
    if (active.some((candidate) => candidate.id === ruleId)) {
      throw refuse.notOff(ruleId);
    }
    throw refuse.unknown(ruleId);
  }
  // Restoring adds an active rule, so the limits for adding apply
  if (hasText(active, rule.text)) throw refuse.duplicate();
  if (active.length >= MAX_ACTIVE_RULES) throw refuse.full();

  tables.deleteDisabledDefault(ruleId);
  return rule;
}
