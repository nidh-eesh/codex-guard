import type { ActiveRule, Severity } from "./rules";
import type {
  ChunkOutcome,
  Finding,
  ModelFinding,
  ReviewResult,
  SkippedFile,
  Verdict
} from "./review-types";

export const UNFINISHED_REVIEW_MESSAGE =
  "Review incomplete: the review couldn't be finished. Try again.";

export interface CombineInput {
  outcomes: readonly ChunkOutcome[];
  /** From the deterministic no-secrets check (D11). */
  secretFindings: readonly ModelFinding[];
  skipped: readonly SkippedFile[];
  /** The rules snapshot the review ran with. */
  rules: readonly ActiveRule[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1 };

/**
 * DESIGN.md 6, step 7: remove duplicates, take each finding's severity from
 * its rule, sort, and decide the verdict. The verdict fails closed (D10).
 */
export function combineReview({
  outcomes,
  secretFindings,
  skipped,
  rules
}: CombineInput): ReviewResult {
  const severityOf = new Map(rules.map((rule) => [rule.id, rule.severity]));
  const seen = new Set<string>();
  const findings: Finding[] = [];

  const add = (finding: ModelFinding, source: Finding["source"]) => {
    // A secrets-check finding is never lost for want of a rule
    const severity =
      severityOf.get(finding.ruleId) ??
      (source === "secrets-check" ? "error" : undefined);
    // Validation drops findings for unknown rules; this is a second line
    if (!severity) return;
    const key = JSON.stringify([finding.ruleId, finding.file, finding.line]);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ...finding, severity, source });
  };

  // Deterministic findings first, so they win a duplicate with the model's
  for (const finding of secretFindings) add(finding, "secrets-check");

  let failed = 0;
  let droppedForErrorRules = 0;
  for (const outcome of outcomes) {
    if (!outcome.reviewed) {
      failed++;
      continue;
    }
    droppedForErrorRules += outcome.droppedForErrorRules;
    for (const finding of outcome.findings) add(finding, "model");
  }

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line
  );

  const verdict: Verdict = findings.some((f) => f.severity === "error")
    ? "fail"
    : failed > 0 || droppedForErrorRules > 0
      ? "incomplete"
      : "pass";

  const notes = skipped.map(
    ({ file, reason }) => `Skipped \`${file}\` (${reason}).`
  );
  if (outcomes.length === 0) {
    notes.push("Nothing to review: every file in the diff was skipped.");
  }
  if (failed > 0) {
    notes.push(
      `Review incomplete: ${failed} of ${outcomes.length} chunks couldn't be reviewed.`
    );
  }
  if (droppedForErrorRules > 0) {
    notes.push(
      `Review incomplete: ${droppedForErrorRules} findings for error rules failed validation.`
    );
  }

  return {
    verdict,
    findings,
    skipped: [...skipped],
    chunks: { total: outcomes.length, failed },
    droppedForErrorRules,
    notes
  };
}

/** Recorded when the review workflow itself errors, so it never looks like a pass. */
export function unfinishedReview(): ReviewResult {
  return {
    verdict: "incomplete",
    findings: [],
    skipped: [],
    chunks: { total: 0, failed: 0 },
    droppedForErrorRules: 0,
    notes: [UNFINISHED_REVIEW_MESSAGE]
  };
}
