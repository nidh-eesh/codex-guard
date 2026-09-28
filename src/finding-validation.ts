import { z } from "zod";
import type { ActiveRule } from "./rules";
import type { Chunk, ModelFinding, ValidatedFindings } from "./review-types";

/*
 * Reviewed module (AGENTS.md): finding validation. Written by an agent,
 * reviewed by the author.
 */

/** The longest message or suggestion kept. */
export const MAX_FINDING_TEXT_LENGTH = 500;

const findingText = z.string().trim().min(1).max(MAX_FINDING_TEXT_LENGTH);

/** A finding's shape. Keys it doesn't know, like a severity, are stripped (D10). */
const FindingShape = z.object({
  ruleId: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  message: findingText,
  suggestion: findingText
});

/** Prefixes the model may copy from a diff header; at most one is removed. */
const PATH_PREFIXES = ["a/", "b/", "./"];

/**
 * DESIGN.md §7, layer 3. Each item is checked on its own:
 *
 * - Shape (Zod): `{ ruleId, file, line, message, suggestion }`, with `line`
 *   a positive integer and text trimmed, non-empty and at most 500
 *   characters.
 * - `ruleId` is in the rules snapshot; `file` is one of the chunk's files;
 *   `line` is one of that file's numbered lines (D13).
 *
 * Findings that pass are kept in the order given, every one of them, even
 * past the findings cap (D21). The rest are dropped and counted; a dropped
 * item whose `ruleId` names an error-severity rule in the snapshot also
 * counts toward `droppedForErrorRules`, whatever else was wrong with it.
 */
export function validateFindings(
  raw: readonly unknown[],
  chunk: Chunk,
  rules: readonly ActiveRule[]
): ValidatedFindings {
  // Sets and a Map, not plain objects: a ruleId or file named "toString" or
  // "__proto__" must not match an inherited property
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const errorRuleIds = new Set(
    rules.filter((rule) => rule.severity === "error").map((rule) => rule.id)
  );
  const linesByFile = new Map(
    chunk.files.map((file) => [file.path, new Set(file.lines)])
  );

  /** An exact match, or one after removing a single leading prefix. */
  const resolveFile = (file: string): string | undefined => {
    if (linesByFile.has(file)) return file;
    const prefix = PATH_PREFIXES.find((p) => file.startsWith(p));
    if (!prefix) return undefined;
    const stripped = file.slice(prefix.length);
    return linesByFile.has(stripped) ? stripped : undefined;
  };

  const check = (item: unknown): ModelFinding | undefined => {
    const parsed = FindingShape.safeParse(item);
    if (!parsed.success || !ruleIds.has(parsed.data.ruleId)) return undefined;
    const file = resolveFile(parsed.data.file);
    if (file === undefined) return undefined;
    if (!linesByFile.get(file)?.has(parsed.data.line)) return undefined;
    return { ...parsed.data, file };
  };

  const result: ValidatedFindings = {
    findings: [],
    dropped: 0,
    droppedForErrorRules: 0
  };
  for (const item of raw) {
    const finding = check(item);
    if (finding) {
      result.findings.push(finding);
      continue;
    }
    result.dropped++;
    const ruleId =
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? (item as { ruleId?: unknown }).ruleId
        : undefined;
    if (typeof ruleId === "string" && errorRuleIds.has(ruleId)) {
      result.droppedForErrorRules++;
    }
  }
  return result;
}
