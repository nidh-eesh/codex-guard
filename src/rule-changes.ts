import { resolveRules } from "./active-rules";
import {
  CUSTOM_RULE_ID_LENGTH,
  CUSTOM_RULE_ID_PREFIX,
  MAX_ACTIVE_RULES,
  RULE_TEXT_MAX_LENGTH,
  RULE_TEXT_MIN_LENGTH,
  STARTER_PACK,
  isLockedRuleId,
  isPossibleRuleId,
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

/** A rule ID that no rule in the workspace has. */
class UnknownRuleError extends RuleError {
  constructor(readonly ruleId: string) {
    super(`No rule with ID \`${ruleId}\` exists in this workspace.`);
  }
}

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
  unknown: (id: string) => new UnknownRuleError(id),
  locked: (id: string) =>
    new RuleError(
      `Rule \`${id}\` is locked and can't be switched off. Locked rules can't be changed; don't try again.`
    ),
  noReason: () =>
    new RuleError("A reason is required to switch off a recommended rule."),
  unquotedReason: () =>
    new RuleError(
      "The reason must be in the user's own words, and it isn't in their recent messages. Ask the user why the team is switching this rule off."
    ),
  noRules: () => new RuleError("Name at least one rule to change."),
  invalidCall: () =>
    new RuleError("The call didn't match the tool, so nothing changed."),
  notApproved: () =>
    new RuleError(
      "This change wasn't approved, so nothing changed. Ask for it again to approve it."
    ),
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
 * locked, no rule could have its ID, or it's a recommended rule and the
 * reason isn't one. A reason is
 * checked only for starter IDs, which are fixed in code; a custom rule needs
 * none.
 */
function removeArgumentRefusal(input: {
  ruleId: string;
  reason?: string;
}): RuleError | undefined {
  const { ruleId } = input;
  if (isLockedRuleId(ruleId)) return refuse.locked(ruleId);
  if (!isPossibleRuleId(ruleId)) return refuse.unknown(ruleId);
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
  if (isLockedRuleId(input.ruleId)) return refuse.lockedRestore(input.ruleId);
  if (!isPossibleRuleId(input.ruleId)) return refuse.unknown(input.ruleId);
  return undefined;
}

const asString = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The rule IDs a removeRule or restoreRule call names, once each. A call
 * made before the tools took lists names one `ruleId`; it's read as a list
 * of one, so an approval pending across a deploy still works.
 */
export function ruleIdsOf(input: unknown): string[] {
  const args = (input ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(args.ruleIds)
    ? args.ruleIds.filter((id): id is string => typeof id === "string")
    : typeof args.ruleId === "string"
      ? [args.ruleId]
      : [];
  return [...new Set(ids)];
}

/** Text compared for a quoted reason: lowercase, whitespace collapsed. */
function quoteKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A reason has to be the user's own words: it must appear in one of their
 * messages the model can see (D28). Depends only on the call and the
 * history, never on the rules in SQLite.
 */
function reasonQuoteRefusal(
  reason: string,
  userTexts: readonly string[]
): RuleError | undefined {
  const key = quoteKey(reason);
  return userTexts.some((text) => quoteKey(text).includes(key))
    ? undefined
    : refuse.unquotedReason();
}

/**
 * Why changing one rule would be refused whatever the rules in SQLite are:
 * its arguments, or, to switch off a recommended rule, a reason that isn't
 * in the user's messages. A change refused this way can't happen however
 * long it waits, so it isn't put to a person (D28).
 */
export function callRefusal(
  toolName: "removeRule" | "restoreRule",
  ruleId: string,
  reason: string | undefined,
  userTexts: readonly string[]
): RuleError | undefined {
  if (toolName === "restoreRule") return restoreArgumentRefusal({ ruleId });
  const argument = removeArgumentRefusal({ ruleId, reason });
  if (argument || !isStarterRuleId(ruleId)) return argument;
  return reasonQuoteRefusal(clean(reason ?? ""), userTexts);
}

const idList = (ids: readonly string[]) => ids.join(", ");

/**
 * The IDs `removeRule` may name: active rules that aren't locked, so the
 * unlocked starter rules and the custom rules (D31). Server-generated only.
 */
export function removableIds(rules: ResolvedRules): string[] {
  return rules.active.filter((rule) => !rule.locked).map((rule) => rule.id);
}

/** The IDs `restoreRule` may name: the switched-off starter rules (D31). */
export function restorableIds(rules: ResolvedRules): string[] {
  return rules.switchedOff.map((rule) => rule.id);
}

/**
 * What the call could have named instead, for a call that named unknown
 * IDs: the model sees the real IDs rather than guessing again.
 */
export function changeableRules(
  toolName: "removeRule" | "restoreRule",
  rules: ResolvedRules
): string {
  if (toolName === "restoreRule") {
    const off = rules.switchedOff.map((rule) => rule.id);
    return off.length > 0
      ? `Rules you can switch back on: ${idList(off)}.`
      : "No rule is switched off.";
  }
  const switchable = rules.active
    .filter((rule) => rule.source === "starter" && !rule.locked)
    .map((rule) => rule.id);
  const deletable = rules.active
    .filter((rule) => rule.source === "custom")
    .map((rule) => rule.id);
  const parts = [
    ...(switchable.length > 0
      ? [`Rules you can switch off: ${idList(switchable)}.`]
      : []),
    ...(deletable.length > 0
      ? [`Custom rules you can delete: ${idList(deletable)}.`]
      : [])
  ];
  return parts.length > 0
    ? parts.join(" ")
    : "No rule can be switched off or deleted right now.";
}

/**
 * The error for a call where nothing changed: each distinct refusal once,
 * with every unknown ID in one sentence followed by the IDs that could
 * have been named.
 */
function callRefusedError(
  toolName: string,
  refusals: readonly RuleError[],
  rules: ResolvedRules,
  extra: readonly string[] = []
): RuleError {
  const unknown = refusals.flatMap((refusal) =>
    refusal instanceof UnknownRuleError ? [refusal.ruleId] : []
  );
  const messages = new Set(
    refusals
      .filter((refusal) => !(refusal instanceof UnknownRuleError))
      .map((refusal) => refusal.message)
  );
  if (
    unknown.length > 0 &&
    (toolName === "removeRule" || toolName === "restoreRule")
  ) {
    const ids = unknown.map((id) => `\`${id}\``);
    messages.add(
      ids.length === 1
        ? `No rule with ID ${ids[0]} exists in this workspace.`
        : `No rules with IDs ${idList(ids)} exist in this workspace.`
    );
    messages.add(changeableRules(toolName, rules));
  }
  for (const message of extra) messages.add(message);
  return new RuleError([...messages].join(" "));
}

/**
 * The refusal for a call the tool's schema rejected before any of our code
 * ran, such as an ID outside the tool's list (D31): each rule's own
 * refusal, worked out from the input, so it reads like any other refusal.
 */
export function schemaRefusal(
  toolName: string,
  input: unknown,
  rules: ResolvedRules
): RuleError {
  if (toolName !== "removeRule" && toolName !== "restoreRule") {
    return refuse.invalidCall();
  }
  const ids = ruleIdsOf(input);
  if (ids.length === 0) return refuse.noRules();
  const reason = asString(((input ?? {}) as Record<string, unknown>).reason);
  const refusals = ids.flatMap((ruleId) => {
    const refusal =
      toolName === "removeRule"
        ? removeRefusal({ ruleId, reason }, rules)
        : restoreRefusal({ ruleId }, rules);
    return refusal ? [refusal] : [];
  });
  return refusals.length > 0
    ? callRefusedError(toolName, refusals, rules)
    : refuse.invalidCall();
}

/** One rule an addRule call adds. */
export interface NewRule {
  text: string;
  severity: Severity;
}

/**
 * The rules an addRule call adds. A call made before addRule took a list
 * names one rule at the top level; it's read as a list of one.
 */
export function rulesToAdd(input: unknown): NewRule[] {
  const args = (input ?? {}) as Record<string, unknown>;
  const list: unknown[] = Array.isArray(args.rules)
    ? args.rules
    : "text" in args
      ? [args]
      : [];
  return list.map((item) => {
    const rule = (item ?? {}) as Record<string, unknown>;
    return {
      text: asString(rule.text),
      severity: rule.severity === "error" ? "error" : "warning"
    };
  });
}

/**
 * Each new rule's refusal, if any, checked in order against the rules the
 * earlier ones would leave: two copies of one text in a call, or a call
 * that reaches the 50-rule cap part way, refuse the later ones.
 */
function addEach(
  items: readonly NewRule[],
  rules: ResolvedRules
): (RuleError | undefined)[] {
  let active = [...rules.active];
  return items.map((item) => {
    const refusal = addRefusal(item, { ...rules, active });
    if (!refusal) {
      active = [
        ...active,
        {
          id: "",
          text: clean(item.text),
          severity: item.severity,
          locked: false,
          source: "custom"
        }
      ];
    }
    return refusal;
  });
}

/**
 * Each change in a call checked against `rules` and the history, without
 * changing anything: the refusals, and how many changes would pass.
 */
function checkEach(
  toolName: string,
  input: unknown,
  rules: ResolvedRules,
  userTexts: readonly string[]
): { refusals: RuleError[]; passing: number } {
  const args = (input ?? {}) as Record<string, unknown>;
  if (toolName === "addRule") {
    const items = rulesToAdd(input);
    if (items.length === 0) return { refusals: [refuse.noRules()], passing: 0 };
    const refusals = addEach(items, rules).filter(
      (refusal): refusal is RuleError => refusal !== undefined
    );
    return { refusals, passing: items.length - refusals.length };
  }
  if (toolName !== "removeRule" && toolName !== "restoreRule") {
    return { refusals: [], passing: 1 };
  }
  const ids = ruleIdsOf(input);
  if (ids.length === 0) return { refusals: [refuse.noRules()], passing: 0 };
  const reason = asString(args.reason);
  const refusals = ids.flatMap((ruleId) => {
    const refusal =
      callRefusal(toolName, ruleId, reason, userTexts) ??
      (toolName === "removeRule"
        ? removeRefusal({ ruleId, reason }, rules)
        : restoreRefusal({ ruleId }, rules));
    return refusal ? [refusal] : [];
  });
  return { refusals, passing: ids.length - refusals.length };
}

/**
 * For `needsApproval`: whether every change in the call would be refused,
 * checked on the rules as they are now. Such a call runs without asking a
 * person and can only be refused (D30); any other call waits for approval.
 */
export function wouldBeRefused(
  toolName: string,
  input: unknown,
  rules: ResolvedRules,
  userTexts: readonly string[]
): boolean {
  return checkEach(toolName, input, rules, userTexts).passing === 0;
}

/**
 * What a call that ran without approval gets: always a refusal, never a
 * change (D30). Each distinct refusal once; if the rules changed since the
 * check so that part of the call would now pass, it says so, and nothing
 * changes anyway.
 */
export function unapprovedRefusal(
  toolName: string,
  input: unknown,
  rules: ResolvedRules,
  userTexts: readonly string[]
): RuleError {
  const { refusals, passing } = checkEach(toolName, input, rules, userTexts);
  return callRefusedError(
    toolName,
    refusals,
    rules,
    passing > 0 ? [refuse.notApproved().message] : []
  );
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

/** What the approval card shows for a call before a person approves it. */
export interface ChangePreview {
  /** Each change that will be refused, as the server will word it. */
  refusals: string[];
  /** Nothing in the call can happen, so Approve is disabled. */
  allRefused: boolean;
}

/**
 * The approval card's preview: the tools' own checks, run on the rules in
 * agent state (D28). The server checks again, in order, when the call runs.
 * A field that isn't a string counts as empty.
 */
export function ruleChangePreview(
  toolName: string,
  input: unknown,
  rules: ResolvedRules
): ChangePreview {
  const args = (input ?? {}) as Record<string, unknown>;
  if (toolName === "addRule") {
    const items = rulesToAdd(input);
    if (items.length === 0) {
      return { refusals: [refuse.noRules().message], allRefused: true };
    }
    const refusals = addEach(items, rules).flatMap((refusal) =>
      refusal ? [refusal.message] : []
    );
    return { refusals, allRefused: refusals.length === items.length };
  }
  if (toolName !== "removeRule" && toolName !== "restoreRule") {
    return { refusals: [], allRefused: false };
  }
  const ids = ruleIdsOf(input);
  if (ids.length === 0) {
    return { refusals: [refuse.noRules().message], allRefused: true };
  }
  const refusals = ids.flatMap((ruleId) => {
    const refusal =
      toolName === "removeRule"
        ? removeRefusal({ ruleId, reason: asString(args.reason) }, rules)
        : restoreRefusal({ ruleId }, rules);
    return refusal ? [refusal.message] : [];
  });
  return { refusals, allRefused: refusals.length === ids.length };
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

export interface AddReport {
  added: CustomRule[];
  refused: { text: string; message: string }[];
  /** The rules after the change, so the model doesn't need to call listRules. */
  rules: RuleIdsNow;
}

/**
 * Adds custom rules, applying each one that passes its checks against the
 * rules the earlier ones left (D32). Reports each rule; when none was
 * added, fails with each distinct refusal. Runs without awaiting, so no
 * other change can interleave with it.
 */
export function addRules(
  tables: RuleTables,
  input: { rules: readonly NewRule[] },
  now: number,
  newId: () => string = newCustomRuleId
): AddReport {
  const items = rulesToAdd(input);
  if (items.length === 0) throw refuse.noRules();
  const added: CustomRule[] = [];
  const refused: AddReport["refused"] = [];
  const errors: RuleError[] = [];
  for (const item of items) {
    try {
      added.push(addRule(tables, item, now, newId));
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      errors.push(error);
      refused.push({ text: clean(item.text), message: error.message });
    }
  }
  if (added.length === 0) {
    throw new RuleError([...new Set(errors.map((e) => e.message))].join(" "));
  }
  return { added, refused, rules: ruleIdsNow(tables) };
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

/** A rule a call named but didn't change, and why. */
export interface ItemRefusal {
  ruleId: string;
  message: string;
}

/** The rules after a change, so the model doesn't need to call listRules. */
export interface RuleIdsNow {
  active: string[];
  switchedOff: string[];
}

export interface RemovalReport {
  switchedOff: string[];
  deleted: string[];
  /** The stored reason, when a recommended rule was switched off. */
  reason?: string;
  refused: ItemRefusal[];
  rules: RuleIdsNow;
}

export interface RestoreReport {
  restored: string[];
  refused: ItemRefusal[];
  rules: RuleIdsNow;
}

function ruleIdsNow(tables: RuleTables): RuleIdsNow {
  const { active, switchedOff } = readRules(tables);
  return {
    active: active.map((rule) => rule.id),
    switchedOff: switchedOff.map((rule) => rule.id)
  };
}

/**
 * Runs `change` for each rule in turn, each against the rules as the ones
 * before it left them, and records the refusals. When nothing changed, the
 * call fails with each distinct refusal, so it reads as the refusal it is.
 */
function changeEach(
  tables: RuleTables,
  toolName: "removeRule" | "restoreRule",
  ruleIds: readonly string[],
  change: (ruleId: string) => void
): ItemRefusal[] {
  if (ruleIds.length === 0) throw refuse.noRules();
  const errors: RuleError[] = [];
  const refused: ItemRefusal[] = [];
  for (const ruleId of ruleIds) {
    try {
      change(ruleId);
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      errors.push(error);
      refused.push({ ruleId, message: error.message });
    }
  }
  if (refused.length === ruleIds.length) {
    throw callRefusedError(toolName, errors, readRules(tables));
  }
  return refused;
}

/**
 * Deletes custom rules and switches off recommended ones, with one shared
 * reason, applying every change that passes its checks (D29). The whole
 * call runs without awaiting, so no other change can interleave with it.
 */
export function removeRules(
  tables: RuleTables,
  input: { ruleIds: readonly string[]; reason?: string },
  now: number,
  userTexts: readonly string[]
): RemovalReport {
  const switchedOff: string[] = [];
  const deleted: string[] = [];
  const refused = changeEach(
    tables,
    "removeRule",
    ruleIdsOf(input),
    (ruleId) => {
      const refusal = callRefusal(
        "removeRule",
        ruleId,
        input.reason,
        userTexts
      );
      if (refusal) throw refusal;
      const removal = removeRule(tables, { ruleId, reason: input.reason }, now);
      (removal.kind === "deleted" ? deleted : switchedOff).push(ruleId);
    }
  );
  return {
    switchedOff,
    deleted,
    ...(switchedOff.length > 0 && { reason: clean(input.reason ?? "") }),
    refused,
    rules: ruleIdsNow(tables)
  };
}

/** Switches recommended rules back on, applying every one that passes (D29). */
export function restoreRules(
  tables: RuleTables,
  input: { ruleIds: readonly string[] }
): RestoreReport {
  const restored: string[] = [];
  const refused = changeEach(
    tables,
    "restoreRule",
    ruleIdsOf(input),
    (ruleId) => {
      restoreRule(tables, { ruleId });
      restored.push(ruleId);
    }
  );
  return { restored, refused, rules: ruleIdsNow(tables) };
}
