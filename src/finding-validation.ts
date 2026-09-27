import { z } from "zod";
import type { ActiveRule } from "./rules";
import type { Chunk, ValidatedFindings } from "./review-types";

/*
 * ⚠ PLACEHOLDER (step 4a). Author-owned module (AGENTS.md): finding
 * validation. Replaced in step 4b.
 *
 * What the real version does (DESIGN.md 7, layer 3): check each finding's
 * shape with Zod, then that its `ruleId` is in the rules snapshot, its
 * `file` is one of the chunk's files, and its `line` is one of that file's
 * numbered lines. Findings that fail are dropped and counted.
 *
 * What this placeholder does: the Zod shape check only. A finding may name
 * any rule, file or line.
 */

const PlaceholderFinding = z.object({
  ruleId: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  message: z.string(),
  suggestion: z.string()
});

export function validateFindings(
  raw: readonly unknown[],
  _chunk: Chunk,
  rules: readonly ActiveRule[]
): ValidatedFindings {
  const errorRules = new Set(
    rules.filter((rule) => rule.severity === "error").map((rule) => rule.id)
  );
  const result: ValidatedFindings = {
    findings: [],
    dropped: 0,
    droppedForErrorRules: 0
  };
  for (const item of raw) {
    const parsed = PlaceholderFinding.safeParse(item);
    if (parsed.success) {
      result.findings.push(parsed.data);
      continue;
    }
    result.dropped++;
    const ruleId = (item as { ruleId?: unknown } | null)?.ruleId;
    if (typeof ruleId === "string" && errorRules.has(ruleId)) {
      result.droppedForErrorRules++;
    }
  }
  return result;
}
