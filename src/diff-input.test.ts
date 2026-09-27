import { describe, expect, it } from "vitest";
import { checkDiff, DiffError, MAX_DIFF_BYTES } from "./diff-input";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
`;

const bytes = (s: string) => new TextEncoder().encode(s).length;

function refusal(input: unknown): string {
  try {
    checkDiff(input);
  } catch (e) {
    expect(e).toBeInstanceOf(DiffError);
    return (e as Error).message;
  }
  throw new Error("expected checkDiff to refuse the input");
}

describe("checkDiff", () => {
  it("accepts a unified diff and returns it unchanged", () => {
    expect(checkDiff(DIFF)).toBe(DIFF);
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "  \n\t "],
    ["something that isn't a string", 42],
    ["nothing", undefined]
  ])("refuses %s as empty", (_case, input) => {
    expect(refusal(input)).toBe(
      "The diff is empty. Paste a unified diff to review."
    );
  });

  it.each([
    ["no hunk header", "just some text\n+added\n"],
    ["@@ that doesn't start a line", "see the @@ -1 +1 @@ marker\n"]
  ])("refuses text with %s", (_case, input) => {
    expect(refusal(input)).toBe(
      "This doesn't look like a unified diff. Paste the output of `git diff`."
    );
  });

  it("accepts exactly 50,000 bytes", () => {
    const diff = DIFF + "x".repeat(MAX_DIFF_BYTES - bytes(DIFF));
    expect(bytes(diff)).toBe(50_000);
    expect(checkDiff(diff)).toBe(diff);
  });

  it("refuses 50,001 bytes", () => {
    const diff = DIFF + "x".repeat(MAX_DIFF_BYTES - bytes(DIFF) + 1);
    expect(refusal(diff)).toBe(
      "The diff is larger than 50 KB. Split it into smaller reviews."
    );
  });

  it("counts UTF-8 bytes, not characters", () => {
    // "€" is 3 bytes: under 50,000 characters, over 50,000 bytes
    const diff = DIFF + "€".repeat(16_700);
    expect(diff.length).toBeLessThan(50_000);
    expect(refusal(diff)).toBe(
      "The diff is larger than 50 KB. Split it into smaller reviews."
    );
  });

  it("checks size before format, so a huge paste gets the size message", () => {
    expect(refusal("x".repeat(60_000))).toBe(
      "The diff is larger than 50 KB. Split it into smaller reviews."
    );
  });
});
