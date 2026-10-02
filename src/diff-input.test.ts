import { describe, expect, it } from "vitest";
import {
  checkDiff,
  DIFF_IN_CHAT_MESSAGE,
  DiffError,
  looksLikeDiff,
  MAX_DIFF_BYTES
} from "./diff-input";

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

describe("looksLikeDiff (D35)", () => {
  it("is true for anything the review box would take as a diff", () => {
    expect(looksLikeDiff(DIFF)).toBe(true);
    expect(checkDiff(DIFF)).toBe(DIFF);
    const hunkOnly = "@@ -1 +1 @@\n-a\n+b";
    expect(looksLikeDiff(hunkOnly)).toBe(true);
    expect(checkDiff(hunkOnly)).toBe(hunkOnly);
  });

  it("is true for a diff with text around it, or a git header alone", () => {
    expect(looksLikeDiff(`Can you review this?\n\n${DIFF}`)).toBe(true);
    expect(looksLikeDiff("```diff\n" + DIFF + "```")).toBe(true);
    expect(looksLikeDiff("diff --git a/x b/x\nnew file mode 100644")).toBe(
      true
    );
  });

  it("is false for chat that only mentions a diff", () => {
    expect(looksLikeDiff("What does @@ -1,2 +1,2 @@ mean in a diff?")).toBe(
      false
    );
    expect(looksLikeDiff("Run `diff --git` and paste it where?")).toBe(false);
    expect(looksLikeDiff("Switch off no-console-log, we use pino")).toBe(false);
    expect(looksLikeDiff("- one\n- two\n+ three")).toBe(false);
  });

  it("asks for the review box in the DESIGN.md section 5 words", () => {
    expect(DIFF_IN_CHAT_MESSAGE).toBe(
      "That looks like a diff. Paste it in the review box to review it."
    );
  });
});
