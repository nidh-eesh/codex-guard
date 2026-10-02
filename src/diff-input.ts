import { z } from "zod";

/** D6. Measured in UTF-8 bytes, not characters. */
export const MAX_DIFF_BYTES = 50_000;

const EMPTY = "The diff is empty. Paste a unified diff to review.";

const diffBytes = (diff: string) => new TextEncoder().encode(diff).length;

// A hunk header: what the review box needs to see to take a diff
const HUNK_HEADER = /^@@ /m;
// What git writes before each file's changes
const GIT_DIFF_HEADER = /^diff --git /m;

/** The DESIGN.md §5 message for a diff sent to the chat (D35). */
export const DIFF_IN_CHAT_MESSAGE =
  "That looks like a diff. Paste it in the review box to review it.";

/**
 * Whether chat text holds a diff: anything the review box would take as
 * one, or a git file header. Diffs never reach the chat model (D35).
 */
export function looksLikeDiff(text: string): boolean {
  return HUNK_HEADER.test(text) || GIT_DIFF_HEADER.test(text);
}

/** A diff pasted into the review box. Checks run in order and stop at the first failure. */
export const DiffInput = z
  .string({ error: EMPTY })
  .refine((diff) => diff.trim() !== "", { error: EMPTY, abort: true })
  .refine((diff) => diffBytes(diff) <= MAX_DIFF_BYTES, {
    error: "The diff is larger than 50 KB. Split it into smaller reviews.",
    abort: true
  })
  .refine((diff) => HUNK_HEADER.test(diff), {
    error:
      "This doesn't look like a unified diff. Paste the output of `git diff`.",
    abort: true
  });

/** A diff refused before review, with its DESIGN.md §5 message. */
export class DiffError extends Error {}

export function checkDiff(input: unknown): string {
  const result = DiffInput.safeParse(input);
  if (!result.success) throw new DiffError(result.error.issues[0].message);
  return result.data;
}
