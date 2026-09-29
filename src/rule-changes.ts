import { resolveRules } from "./active-rules";
import {
  CUSTOM_RULE_ID_LENGTH,
  CUSTOM_RULE_ID_PREFIX,
  MAX_ACTIVE_RULES,
  RULE_TEXT_MAX_LENGTH,
  RULE_TEXT_MIN_LENGTH,
  STARTER_PACK,
  isLockedRuleId,
  isStarterRuleId,
  type ActiveRule,
  type CustomRule,
  type DisabledDefault,
  type ResolvedRules,
  type Severity,
  type SwitchedOffRule
} from "./rules";

export const REASON_MAX_LENGTH = 200;
/** A reason shorter than this can't say why a rule is being switched off. */
export const REASON_MIN_LENGTH = 10;

/**
 * Stand-ins for a reason, which a model may write when the user gave none.
 * Compared in lowercase, ignoring punctuation.
 */
const PLACEHOLDER_REASONS = new Set([
  "no reason",
  "no reason given",
  "no reason provided",
  "no particular reason",
  "not needed",
  "not required",
  "not applicable",
  "not specified",
  "unspecified",
  "just because",
  "no comment",
  "user request",
  "user requested",
  "requested by user",
  "requested by the user",
  "as requested"
]);

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
    new RuleError(
      `Rule \`${id}\` is locked and can't be switched off. Locked rules can't be changed; don't try again.`
    ),
  noReason: () =>
    new RuleError("A reason is required to switch off a recommended rule."),
  weakReason: () =>
    new RuleError(
      `The reason must say why the team is switching this rule off, in at least ${REASON_MIN_LENGTH} characters.`
    ),
  reasonLength: () =>
    new RuleError(
      `The reason must be at most ${REASON_MAX_LENGTH} characters.`
    ),
  lockedRestore: (id: string) =>
    new RuleError(
      `Rule \`${id}\` is locked and always on. Locked rules can't be changed; don't try again.`
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
  // A UUID starts with 8 hex characters
  const hex = CUSTOM_RULE_ID_LENGTH - CUSTOM_RULE_ID_PREFIX.length;
  return `${CUSTOM_RULE_ID_PREFIX}${crypto.randomUUID().slice(0, hex)}`;
}

/** A reason that names no reason, in lowercase without punctuation. */
function isPlaceholderReason(reason: string): boolean {
  const key = reason
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/ +/g, " ")
    .trim();
  return PLACEHOLDER_REASONS.has(key);
}

// Refusals come in two kinds (D28). An argument refusal depends only on the
// call's arguments and the starter pack in code: a call that meets one can't
// change anything whenever it runs, so it's refused without asking a person.
// A state refusal depends on the rules in SQLite (already off, not off, a
// duplicate, the 50-rule cap), which can change between the approval check
// and `execute`, so those calls wait for approval and `execute` checks again.

/** Why adding this rule would be refused on its arguments alone. */
function addArgumentRefusal(input: { text: string }): RuleError | undefined {
  const text = clean(input.text);
  if (
    text.length < RULE_TEXT_MIN_LENGTH ||
    text.length > RULE_TEXT_MAX_LENGTH
  ) {
    return refuse.textLength();
  }
  return undefined;
}

/**
 * Why removing this rule would be refused on its arguments alone: it's
 * locked, or it's a recommended rule and the reason isn't one. A reason is
 * checked only for starter IDs, which are fixed in code; a custom rule needs
 * none.
 */
function removeArgumentRefusal(input: {
  ruleId: string;
  reason?: string;
}): RuleError | undefined {
  const { ruleId } = input;
  if (isLockedRuleId(ruleId)) return refuse.locked(ruleId);
  if (!isStarterRuleId(ruleId)) return undefined;
  const reason = clean(input.reason ?? "");
  if (!reason) return refuse.noReason();
  if (reason.length < REASON_MIN_LENGTH || isPlaceholderReason(reason)) {
    return refuse.weakReason();
  }
  if (reason.length > REASON_MAX_LENGTH) return refuse.reasonLength();
  return undefined;
}

/** Why restoring this rule would be refused on its arguments alone. */
function restoreArgumentRefusal(input: {
  ruleId: string;
}): RuleError | undefined {
  return isLockedRuleId(input.ruleId)
    ? refuse.lockedRestore(input.ruleId)
    : undefined;
}

const asString = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * A refusal that doesn't depend on the rules in SQLite, for `needsApproval`:
 * the rule tools run a call that meets one without asking a person, and
 * `execute` refuses it at once. A field that isn't a string counts as empty.
 */
export function argumentRefusal(
  toolName: string,
  input: unknown
): RuleError | undefined {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "addRule":
      return addArgumentRefusal({ text: asString(args.text) });
    case "removeRule":
      return removeArgumentRefusal({
        ruleId: asString(args.ruleId),
        reason: asString(args.reason)
      });
    case "restoreRule":
      return restoreArgumentRefusal({ ruleId: asString(args.ruleId) });
    default:
      return undefined;
  }
}

// Each change's full checks, arguments first, then state. `execute` runs them
// on the rules just read from SQLite; the approval card runs the same ones on
// the rules in agent state, to warn before a person approves a change that
// will be refused.

/** Why adding this rule would be refused, if it would be. */
export function addRefusal(
  input: { text: string },
  rules: ResolvedRules
): RuleError | undefined {
  const argument = addArgumentRefusal(input);
  if (argument) return argument;
  const text = clean(input.text);
  if (hasText(rules.active, text)) return refuse.duplicate();
  if (rules.active.length >= MAX_ACTIVE_RULES) return refuse.full();
  return undefined;
}

/** Why removing or switching off this rule would be refused, if it would be. */
export function removeRefusal(
  input: { ruleId: string; reason?: string },
  rules: ResolvedRules
): RuleError | undefined {
  const argument = removeArgumentRefusal(input);
  if (argument) return argument;
  const { ruleId } = input;
  if (rules.switchedOff.some((rule) => rule.id === ruleId)) {
    return refuse.alreadyOff(ruleId);
  }
  const rule = rules.active.find((candidate) => candidate.id === ruleId);
  if (!rule) return refuse.unknown(ruleId);
  // Already refused above; kept so a locked rule can never be removed
  if (rule.locked) return refuse.locked(ruleId);
  return undefined;
}

/** Why restoring this rule would be refused, if it would be. */
export function restoreRefusal(
  input: { ruleId: string },
  rules: ResolvedRules
): RuleError | undefined {
  const argument = restoreArgumentRefusal(input);
  if (argument) return argument;
  const { ruleId } = input;
  const rule = rules.switchedOff.find((candidate) => candidate.id === ruleId);
  if (!rule) {
    return rules.active.some((candidate) => candidate.id === ruleId)
      ? refuse.notOff(ruleId)
      : refuse.unknown(ruleId);
  }
  // Restoring adds an active rule, so the limits for adding apply
  if (hasText(rules.active, rule.text)) return refuse.duplicate();
  if (rules.active.length >= MAX_ACTIVE_RULES) return refuse.full();
  return undefined;
}

/**
 * The refusal a rule tool call would meet, for the approval card. A field
 * that isn't a string counts as empty; `execute` checks the real input.
 */
export function ruleChangeRefusal(
  toolName: string,
  input: unknown,
  rules: ResolvedRules
): string | undefined {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "addRule":
      return addRefusal({ text: asString(args.text) }, rules)?.message;
    case "removeRule":
      return removeRefusal(
        { ruleId: asString(args.ruleId), reason: asString(args.reason) },
        rules
      )?.message;
    case "restoreRule":
      return restoreRefusal({ ruleId: asString(args.ruleId) }, rules)?.message;
    default:
      return undefined;
  }
}

// Each change reads, checks and writes without awaiting in between. A Durable
// Object runs one such block at a time, so two changes can't interleave.

export function addRule(
  tables: RuleTables,
  input: { text: string; severity: Severity },
  now: number,
  newId: () => string = newCustomRuleId
): CustomRule {
  const refusal = addRefusal(input, readRules(tables));
  if (refusal) throw refusal;

  const rule: CustomRule = {
    id: newId(),
    text: clean(input.text),
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
  const rules = readRules(tables);
  const refusal = removeRefusal(input, rules);
  if (refusal) throw refusal;

  const { ruleId } = input;
  const rule = rules.active.find((candidate) => candidate.id === ruleId)!;
  if (rule.source === "custom") {
    tables.deleteCustomRule(ruleId);
    return { kind: "deleted", rule };
  }
  const reason = clean(input.reason ?? "");
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
  const rules = readRules(tables);
  const refusal = restoreRefusal(input, rules);
  if (refusal) throw refusal;

  const rule = rules.switchedOff.find(
    (candidate) => candidate.id === input.ruleId
  )!;
  tables.deleteDisabledDefault(input.ruleId);
  return rule;
}
