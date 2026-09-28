import { describe, expect, it } from "vitest";
import { combineReview, unfinishedReview } from "./review-combine";
import type { ChunkOutcome, ModelFinding } from "./review-types";
import type { ActiveRule } from "./rules";

const rule = (
  id: string,
  severity: "error" | "warning",
  source: "starter" | "custom" = "starter"
): ActiveRule => ({
  id,
  text: `Rule ${id}`,
  severity,
  locked: id === "no-secrets",
  source
});

const RULES = [
  rule("no-secrets", "error"),
  rule("validate-input", "error"),
  rule("no-console-log", "warning"),
  rule("c_1a2b3c4d", "warning", "custom")
];

const finding = (
  ruleId: string,
  file = "src/a.ts",
  line = 1
): ModelFinding => ({
  ruleId,
  file,
  line,
  message: `Breaks ${ruleId}`,
  suggestion: "Fix it"
});

const reviewed = (
  findings: ModelFinding[] = [],
  droppedForErrorRules = 0,
  atCap = false
): ChunkOutcome => ({
  reviewed: true,
  findings,
  dropped: droppedForErrorRules,
  droppedForErrorRules,
  atCap,
  usage: { inputTokens: 100, outputTokens: 10 }
});

const combine = (
  outcomes: ChunkOutcome[],
  secretFindings: ModelFinding[] = []
) => combineReview({ outcomes, secretFindings, skipped: [], rules: RULES });

describe("combineReview verdict", () => {
  it("passes with no findings and every chunk reviewed", () => {
    expect(combine([reviewed(), reviewed()])).toMatchObject({
      verdict: "pass",
      findings: [],
      notes: []
    });
  });

  it("passes with only warnings, and lists them", () => {
    const result = combine([reviewed([finding("no-console-log")])]);
    expect(result.verdict).toBe("pass");
    expect(result.findings).toHaveLength(1);
  });

  it("fails on an error-rule finding", () => {
    expect(combine([reviewed([finding("validate-input")])]).verdict).toBe(
      "fail"
    );
  });

  it("is incomplete, never pass, when a chunk failed after its retries", () => {
    const result = combine([reviewed(), { reviewed: false }]);
    expect(result.verdict).toBe("incomplete");
    expect(result.chunks).toEqual({ total: 2, failed: 1 });
    expect(result.notes).toEqual([
      "Review incomplete: 1 of 2 chunks couldn't be reviewed."
    ]);
  });

  it("is incomplete, never pass, when findings for error rules were discarded", () => {
    const result = combine([reviewed([], 3)]);
    expect(result.verdict).toBe("incomplete");
    expect(result.notes).toEqual([
      "Review incomplete: 3 findings for error rules failed validation."
    ]);
  });

  it("shows both counts when both apply", () => {
    expect(combine([reviewed([], 2), { reviewed: false }]).notes).toEqual([
      "Review incomplete: 1 of 2 chunks couldn't be reviewed.",
      "Review incomplete: 2 findings for error rules failed validation."
    ]);
  });

  it("fails rather than incomplete when an error finding survives, keeping the notes", () => {
    const result = combine([
      reviewed([finding("no-secrets")]),
      { reviewed: false }
    ]);
    expect(result.verdict).toBe("fail");
    expect(result.notes).toContain(
      "Review incomplete: 1 of 2 chunks couldn't be reviewed."
    );
  });
});

describe("combineReview at the findings cap", () => {
  const warnings = Array.from({ length: 3 }, (_, i) =>
    finding("no-console-log", "src/a.ts", i + 1)
  );

  it("is incomplete, not pass, when a chunk reached the cap with only warnings", () => {
    const result = combine([reviewed(warnings, 0, true), reviewed()]);
    expect(result.verdict).toBe("incomplete");
    expect(result.notes).toEqual([
      "Too many findings in one part of the diff to be sure no error was missed. Fix these and review again."
    ]);
  });

  it("keeps every finding from a chunk at the cap", () => {
    expect(combine([reviewed(warnings, 0, true)]).findings).toHaveLength(3);
  });

  it("still fails when a chunk at the cap has an error finding", () => {
    const result = combine([
      reviewed([...warnings, finding("validate-input")], 0, true)
    ]);
    expect(result.verdict).toBe("fail");
    expect(result.notes).toContain(
      "Too many findings in one part of the diff to be sure no error was missed. Fix these and review again."
    );
  });

  it("adds the note once, however many chunks reached the cap", () => {
    const result = combine([
      reviewed(warnings, 0, true),
      reviewed(warnings, 0, true)
    ]);
    expect(result.notes).toHaveLength(1);
  });
});

describe("combineReview findings", () => {
  it("takes severity from the rule, not the model", () => {
    const [f] = combine([reviewed([finding("c_1a2b3c4d")])]).findings;
    expect(f).toMatchObject({ severity: "warning", source: "model" });
  });

  it("removes duplicates across chunks by rule, file and line", () => {
    const same = finding("validate-input", "src/a.ts", 4);
    const result = combine([reviewed([same]), reviewed([{ ...same }])]);
    expect(result.findings).toHaveLength(1);
  });

  it("keeps findings that differ only by line", () => {
    const result = combine([
      reviewed([
        finding("validate-input", "src/a.ts", 4),
        finding("validate-input", "src/a.ts", 5)
      ])
    ]);
    expect(result.findings).toHaveLength(2);
  });

  it("keeps the secrets check's finding over the model's duplicate", () => {
    const result = combine(
      [reviewed([finding("no-secrets", "src/k.ts", 2)])],
      [{ ...finding("no-secrets", "src/k.ts", 2), message: "Regex hit" }]
    );
    expect(result.findings).toEqual([
      expect.objectContaining({ source: "secrets-check", message: "Regex hit" })
    ]);
  });

  it("drops a finding for a rule that isn't in the snapshot", () => {
    expect(combine([reviewed([finding("made-up-rule")])]).findings).toEqual([]);
  });

  it("keeps a secrets-check finding as an error even without the rule", () => {
    const result = combineReview({
      outcomes: [reviewed()],
      secretFindings: [finding("no-secrets")],
      skipped: [],
      rules: []
    });
    expect(result).toMatchObject({
      verdict: "fail",
      findings: [{ severity: "error" }]
    });
  });

  it("sorts errors first, then by file, then by line", () => {
    const result = combine([
      reviewed([
        finding("no-console-log", "src/a.ts", 1),
        finding("validate-input", "src/b.ts", 9),
        finding("validate-input", "src/b.ts", 2),
        finding("no-secrets", "src/a.ts", 5)
      ])
    ]);
    expect(
      result.findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`)
    ).toEqual([
      "no-secrets src/a.ts:5",
      "validate-input src/b.ts:2",
      "validate-input src/b.ts:9",
      "no-console-log src/a.ts:1"
    ]);
  });
});

describe("combineReview notes", () => {
  it("notes each skipped file", () => {
    const result = combineReview({
      outcomes: [reviewed()],
      secretFindings: [],
      skipped: [
        { file: "package-lock.json", reason: "lockfile" },
        { file: "dist/app.min.js", reason: "minified or generated" }
      ],
      rules: RULES
    });
    expect(result.notes).toEqual([
      "Skipped `package-lock.json` (lockfile).",
      "Skipped `dist/app.min.js` (minified or generated)."
    ]);
  });

  it("says there was nothing to review when every file was skipped", () => {
    const result = combineReview({
      outcomes: [],
      secretFindings: [],
      skipped: [{ file: "logo.png", reason: "binary" }],
      rules: RULES
    });
    expect(result.notes).toEqual([
      "Skipped `logo.png` (binary).",
      "Nothing to review: every file in the diff was skipped."
    ]);
  });

  it("still fails a fully skipped diff when the secrets check finds a key", () => {
    const result = combineReview({
      outcomes: [],
      secretFindings: [finding("no-secrets", "config.min.js", 1)],
      skipped: [{ file: "config.min.js", reason: "minified or generated" }],
      rules: RULES
    });
    expect(result.verdict).toBe("fail");
  });
});

describe("unfinishedReview", () => {
  it("is incomplete, never pass, with a note saying so", () => {
    expect(unfinishedReview()).toMatchObject({
      verdict: "incomplete",
      findings: [],
      notes: ["Review incomplete: the review couldn't be finished. Try again."]
    });
  });
});
