import type { SplitDiff } from "./review-types";

/*
 * What the real version does (DESIGN.md §6, step 4): skip lockfiles, binary,
 * and minified or generated files with a note for each; list every added
 * line, skipped files included, for the no-secrets check; prefix each added
 * and context line with its new-file line number (D13); split files and
 * hunks that are too big; pack the pieces first-fit into chunks that fit the
 * per-call token budget.
 *
 * What this placeholder does: the whole diff as one chunk, with no line
 * numbers, no file list, nothing skipped and no added lines. So the
 * no-secrets check has nothing to scan, and the model counts lines itself.
 */
export function splitDiff(diff: string): SplitDiff {
  return {
    chunks: [{ text: diff, files: [] }],
    skipped: [],
    addedLines: []
  };
}
