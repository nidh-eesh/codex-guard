import type { Severity } from "./rules";

export type Verdict = "pass" | "fail" | "incomplete";

export type SkipReason = "lockfile" | "binary" | "minified or generated";

export interface SkippedFile {
  file: string;
  reason: SkipReason;
}

/** A file in a chunk, with the new-file line numbers a finding may point at (D13). */
export interface ChunkFile {
  path: string;
  /** Numbers of the added and context lines shown in the chunk. */
  lines: number[];
}

/** One review call's worth of diff. */
export interface Chunk {
  /**
   * What the review model reads: file headers and lines, each added or
   * context line prefixed with its new-file line number (D13).
   */
  text: string;
  files: ChunkFile[];
}

/** An added line, from every file, skipped ones included: what the no-secrets check scans (D11). */
export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export interface SplitDiff {
  chunks: Chunk[];
  skipped: SkippedFile[];
  addedLines: AddedLine[];
}

/** A finding as the review model writes it. Severity comes from the rule (D10). */
export interface ModelFinding {
  ruleId: string;
  file: string;
  line: number;
  message: string;
  suggestion: string;
}

export interface ValidatedFindings {
  findings: ModelFinding[];
  /** Findings that failed validation and were discarded. */
  dropped: number;
  /** Of those, the ones whose `ruleId` names an error-severity rule. */
  droppedForErrorRules: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ChunkOutcome =
  | ({
      reviewed: true;
      usage: TokenUsage;
      /**
       * The model returned at least MAX_FINDINGS_PER_CHUNK findings, valid or
       * not, so it may have left violations out.
       */
      atCap: boolean;
    } & ValidatedFindings)
  /** The chunk still failed after its retries. */
  | { reviewed: false };

export interface Finding extends ModelFinding {
  severity: Severity;
  source: "model" | "secrets-check";
}

export interface ReviewResult {
  verdict: Verdict;
  /** Error findings first, then by file and line. */
  findings: Finding[];
  skipped: SkippedFile[];
  chunks: { total: number; failed: number };
  droppedForErrorRules: number;
  /** DESIGN.md §5 messages to show with the review. */
  notes: string[];
}
