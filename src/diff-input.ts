import { z } from "zod";

/** D6. Measured in UTF-8 bytes, not characters. */
export const MAX_DIFF_BYTES = 50_000;

const EMPTY = "The diff is empty. Paste a unified diff to review.";

const diffBytes = (diff: string) => new TextEncoder().encode(diff).length;

/** A diff pasted into the review box. Checks run in order and stop at the first failure. */
export const DiffInput = z
  .string({ error: EMPTY })
  .refine((diff) => diff.trim() !== "", { error: EMPTY, abort: true })
  .refine((diff) => diffBytes(diff) <= MAX_DIFF_BYTES, {
    error: "The diff is larger than 50 KB. Split it into smaller reviews.",
    abort: true
  })
  .refine((diff) => /^@@ /m.test(diff), {
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
