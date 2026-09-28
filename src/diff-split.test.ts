import { describe, expect, it } from "vitest";
import { splitDiff } from "./diff-split";
import { MODEL } from "./model-config";
import type { SplitDiff } from "./review-types";
import { chunkBudget, estimateTokens, type ChunkBudget } from "./token-budget";

/** Room for everything: these tests check parsing, not packing. */
const ROOMY: ChunkBudget = { available: 17_000, target: 12_000 };
/** Small enough to force splitting with a few short hunks. */
const SMALL: ChunkBudget = { available: 400, target: 300 };

function modified(path: string, ...lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...lines
  ].join("\n");
}

function created(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n");
}

function deleted(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-first",
    "-second"
  ].join("\n");
}

const diffOf = (...files: string[]) => `${files.join("\n")}\n`;

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const line60 = (label: string) => label.padEnd(60, "x");

/** A hunk of `count` added lines of 60 characters, from new line `start`. */
const addedHunk = (start: number, count: number, label: string) => [
  `@@ -${start - 1},0 +${start},${count} @@`,
  ...Array.from({ length: count }, (_, i) => `+${line60(`${label}${i}`)}`)
];

/** Every numbered line of `path` across all chunks, sorted. */
const linesOf = (split: SplitDiff, path: string) =>
  split.chunks
    .flatMap((chunk) => chunk.files.filter((f) => f.path === path))
    .flatMap((file) => file.lines)
    .sort((a, b) => a - b);

const pathsOf = (split: SplitDiff) => [
  ...new Set(split.chunks.flatMap((chunk) => chunk.files.map((f) => f.path)))
];

describe("splitDiff line numbers (D13)", () => {
  const HUNK = [
    "@@ -10,4 +10,5 @@",
    " context a",
    "-deleted b",
    "+added c",
    "+added d",
    " context e",
    " context f"
  ];

  it("numbers added and context lines with their new-file line numbers", () => {
    const split = splitDiff(diffOf(modified("src/a.ts", ...HUNK)), ROOMY);
    expect(linesOf(split, "src/a.ts")).toEqual([10, 11, 12, 13, 14]);
  });

  it("shows each number on the same line as the text it numbers", () => {
    const [chunk] = splitDiff(
      diffOf(modified("src/a.ts", ...HUNK)),
      ROOMY
    ).chunks;
    expect(chunk.text).toMatch(/\b11\b[^\n]*added c/);
    expect(chunk.text).toMatch(/\b14\b[^\n]*context f/);
  });

  it("restarts numbering at each hunk header", () => {
    const diff = diffOf(
      modified(
        "src/a.ts",
        "@@ -1,2 +1,3 @@",
        " one",
        "+two",
        " three",
        "@@ -20,2 +21,2 @@",
        "-old",
        "+new",
        " after"
      )
    );
    expect(linesOf(splitDiff(diff, ROOMY), "src/a.ts")).toEqual([
      1, 2, 3, 21, 22
    ]);
  });

  it("reads a hunk header without line counts", () => {
    const diff = diffOf(modified("src/a.ts", "@@ -5 +5 @@", "-old", "+new"));
    expect(linesOf(splitDiff(diff, ROOMY), "src/a.ts")).toEqual([5]);
  });

  it("numbers a new file from 1", () => {
    const split = splitDiff(
      diffOf(created("src/new.ts", ["a", "b", "c"])),
      ROOMY
    );
    expect(linesOf(split, "src/new.ts")).toEqual([1, 2, 3]);
  });

  it("ignores the no-newline marker", () => {
    const diff = diffOf(
      modified(
        "src/a.ts",
        "@@ -1,1 +1,2 @@",
        " keep",
        "+last",
        "\\ No newline at end of file"
      )
    );
    expect(linesOf(splitDiff(diff, ROOMY), "src/a.ts")).toEqual([1, 2]);
  });

  it("reads CRLF line endings like LF", () => {
    const diff = diffOf(modified("src/a.ts", ...HUNK)).replaceAll("\n", "\r\n");
    expect(linesOf(splitDiff(diff, ROOMY), "src/a.ts")).toEqual([
      10, 11, 12, 13, 14
    ]);
  });

  it("reads a deleted line starting with -- as a line, not a file header", () => {
    // Deleting the SQL comment "-- old" gives the line "--- old"
    const diff = diffOf(
      modified(
        "db/schema.sql",
        "@@ -1,3 +1,3 @@",
        " create table a();",
        "--- old",
        "+-- new",
        " create table b();"
      )
    );
    const split = splitDiff(diff, ROOMY);
    expect(pathsOf(split)).toEqual(["db/schema.sql"]);
    expect(linesOf(split, "db/schema.sql")).toEqual([1, 2, 3]);
  });

  it("reads plain diff -u output, without diff --git lines", () => {
    const diff = diffOf(
      [
        "--- src/a.ts.orig\t2026-09-28 10:00:00",
        "+++ src/a.ts\t2026-09-28 10:05:00",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "--- src/b.ts.orig\t2026-09-28 10:00:00",
        "+++ src/b.ts\t2026-09-28 10:05:00",
        "@@ -4 +4 @@",
        "-old",
        "+new"
      ].join("\n")
    );
    const split = splitDiff(diff, ROOMY);
    expect(linesOf(split, "src/a.ts")).toEqual([1]);
    expect(linesOf(split, "src/b.ts")).toEqual([4]);
  });
});

describe("splitDiff files", () => {
  const change = ["@@ -1 +1 @@", "-x", "+y"];

  it("lists each file by its path, in diff order", () => {
    const diff = diffOf(
      modified("src/a.ts", ...change),
      modified("src/b.ts", ...change)
    );
    expect(pathsOf(splitDiff(diff, ROOMY))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("uses a renamed file's new path", () => {
    const diff = diffOf(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 90%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "--- a/src/old.ts",
        "+++ b/src/new.ts",
        ...change
      ].join("\n")
    );
    expect(pathsOf(splitDiff(diff, ROOMY))).toEqual(["src/new.ts"]);
  });

  it("handles a path with spaces", () => {
    const diff = diffOf(modified("docs/my notes.md", ...change));
    expect(pathsOf(splitDiff(diff, ROOMY))).toEqual(["docs/my notes.md"]);
  });

  it("handles a file named __proto__", () => {
    const split = splitDiff(diffOf(modified("__proto__", ...change)), ROOMY);
    expect(linesOf(split, "__proto__")).toEqual([1]);
  });

  it("shows each file's path in its chunk", () => {
    const [chunk] = splitDiff(
      diffOf(modified("src/a.ts", ...change)),
      ROOMY
    ).chunks;
    expect(chunk.text).toContain("src/a.ts");
  });

  it("reviews nothing in a deleted file, and doesn't note it as skipped", () => {
    const split = splitDiff(diffOf(deleted("src/gone.ts")), ROOMY);
    expect(linesOf(split, "src/gone.ts")).toEqual([]);
    expect(split.skipped).toEqual([]);
    expect(split.addedLines).toEqual([]);
  });
});

describe("splitDiff skips", () => {
  const change = ["@@ -1 +1 @@", "-a", "+b"];

  it.each([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "web/package-lock.json"
  ])("the lockfile %s", (path) => {
    const split = splitDiff(diffOf(modified(path, ...change)), ROOMY);
    expect(split.skipped).toEqual([{ file: path, reason: "lockfile" }]);
    expect(split.chunks).toEqual([]);
  });

  it("a changed binary file", () => {
    const diff = diffOf(
      [
        "diff --git a/logo.png b/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/logo.png and b/logo.png differ"
      ].join("\n")
    );
    const split = splitDiff(diff, ROOMY);
    expect(split.skipped).toEqual([{ file: "logo.png", reason: "binary" }]);
    expect(split.addedLines).toEqual([]);
  });

  it("a new binary file", () => {
    const diff = diffOf(
      [
        "diff --git a/assets/icon.png b/assets/icon.png",
        "new file mode 100644",
        "index 0000000..2222222",
        "Binary files /dev/null and b/assets/icon.png differ"
      ].join("\n")
    );
    expect(splitDiff(diff, ROOMY).skipped).toEqual([
      { file: "assets/icon.png", reason: "binary" }
    ]);
  });

  it.each(["dist/app.min.js", "public/styles.min.css", "dist/app.js.map"])(
    "the minified or generated file %s",
    (path) => {
      const split = splitDiff(diffOf(modified(path, ...change)), ROOMY);
      expect(split.skipped).toEqual([
        { file: path, reason: "minified or generated" }
      ]);
    }
  );

  it("a file with an added line over 1,000 characters", () => {
    const diff = diffOf(
      modified("src/bundle.js", "@@ -1 +1 @@", "-a", `+${"x".repeat(1_001)}`)
    );
    expect(splitDiff(diff, ROOMY).skipped).toEqual([
      { file: "src/bundle.js", reason: "minified or generated" }
    ]);
  });

  it("not a file whose longest added line is exactly 1,000 characters", () => {
    const diff = diffOf(
      modified("src/data.ts", "@@ -1 +1 @@", "-a", `+${"x".repeat(1_000)}`)
    );
    const split = splitDiff(diff, ROOMY);
    expect(split.skipped).toEqual([]);
    expect(linesOf(split, "src/data.ts")).toEqual([1]);
  });

  it("with notes in diff order, reviewing the other files", () => {
    const diff = diffOf(
      modified("yarn.lock", ...change),
      modified("src/a.ts", ...change),
      modified("app.min.js", ...change)
    );
    const split = splitDiff(diff, ROOMY);
    expect(split.skipped.map((s) => s.file)).toEqual([
      "yarn.lock",
      "app.min.js"
    ]);
    expect(pathsOf(split)).toEqual(["src/a.ts"]);
  });

  it("everything, leaving no chunks", () => {
    const split = splitDiff(diffOf(modified("yarn.lock", ...change)), ROOMY);
    expect(split.chunks).toEqual([]);
  });
});

describe("splitDiff added lines for the no-secrets check (D11)", () => {
  it("lists each added line with its file and new-file number, without the +", () => {
    const diff = diffOf(
      modified(
        "src/a.ts",
        "@@ -10,3 +10,4 @@",
        " keep",
        "-old",
        "+first",
        "+second",
        " keep too"
      )
    );
    expect(splitDiff(diff, ROOMY).addedLines).toEqual([
      { file: "src/a.ts", line: 11, text: "first" },
      { file: "src/a.ts", line: 12, text: "second" }
    ]);
  });

  it("includes added lines from skipped text files, in diff order", () => {
    const diff = diffOf(
      modified("config.min.js", "@@ -1 +1 @@", "-a", "+const key = 1;"),
      modified("yarn.lock", "@@ -3 +3 @@", "-a", "+b")
    );
    expect(splitDiff(diff, ROOMY).addedLines).toEqual([
      { file: "config.min.js", line: 1, text: "const key = 1;" },
      { file: "yarn.lock", line: 3, text: "b" }
    ]);
  });
});

describe("splitDiff chunks (D6)", () => {
  it("puts a small diff in one chunk", () => {
    const diff = diffOf(created("src/a.ts", ["one", "two"]));
    expect(splitDiff(diff, ROOMY).chunks).toHaveLength(1);
  });

  it("never returns an empty chunk", () => {
    const diff = diffOf(deleted("src/gone.ts"), created("src/a.ts", ["one"]));
    for (const chunk of splitDiff(diff, ROOMY).chunks) {
      expect(chunk.files.some((f) => f.lines.length > 0)).toBe(true);
    }
  });

  it("splits a file larger than one chunk by hunk", () => {
    // Each hunk is about 230 tokens: no two fit in 300
    const diff = diffOf(
      modified(
        "src/big.ts",
        ...addedHunk(1, 9, "a"),
        ...addedHunk(31, 9, "b"),
        ...addedHunk(61, 9, "c")
      )
    );
    const split = splitDiff(diff, SMALL);
    expect(split.chunks.map((c) => c.files.flatMap((f) => f.lines))).toEqual([
      range(1, 9),
      range(31, 39),
      range(61, 69)
    ]);
    for (const chunk of split.chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(SMALL.target);
      expect(chunk.text).toContain("src/big.ts");
    }
  });

  it("splits a hunk larger than one chunk into windows of lines", () => {
    const split = splitDiff(
      diffOf(modified("src/huge.ts", ...addedHunk(1, 40, "line"))),
      SMALL
    );
    const windows = split.chunks.map((c) => c.files.flatMap((f) => f.lines));
    expect(windows.length).toBeGreaterThan(1);
    // Every line exactly once, in order, each window a run of lines
    expect(windows.flat()).toEqual(range(1, 40));
    for (const window of windows) {
      expect(window).toEqual(range(window[0], window[window.length - 1]));
    }
    for (const chunk of split.chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(SMALL.target);
      expect(chunk.text).toContain("src/huge.ts");
    }
  });

  it("packs first-fit: a later file fills an earlier chunk before a new one opens", () => {
    // About 230, 470 and 230 tokens against a 600 target. Next-fit would
    // need 3 chunks; first-fit puts the two small files together.
    const lines = (label: string, count: number) =>
      Array.from({ length: count }, (_, i) => line60(`${label}${i}`));
    const diff = diffOf(
      created("src/small-1.ts", lines("s1-", 9)),
      created("src/big.ts", lines("b-", 20)),
      created("src/small-2.ts", lines("s2-", 9))
    );
    const split = splitDiff(diff, { available: 800, target: 600 });
    expect(split.chunks.map((c) => c.files.map((f) => f.path))).toEqual([
      ["src/small-1.ts", "src/small-2.ts"],
      ["src/big.ts"]
    ]);
  });

  it("packs any diff up to 18k tokens into at most 2 chunks, none over 12k (AGENTS.md)", () => {
    const budget = chunkBudget(MODEL);
    const next = seededRandom(20260928);
    let boundChecked = 0;
    for (let i = 0; i < 150; i++) {
      const { chunks } = splitDiff(randomDiff(next), budget);
      const sizes = chunks.map((chunk) => estimateTokens(chunk.text));
      for (const size of sizes) {
        expect(size, `diff ${i}`).toBeLessThanOrEqual(budget.target);
      }
      if (sizes.reduce((sum, size) => sum + size, 0) <= 18_000) {
        boundChecked++;
        expect(chunks.length, `diff ${i}`).toBeLessThanOrEqual(2);
      }
    }
    // The bound was really exercised, not skipped for every diff
    expect(boundChecked).toBeGreaterThanOrEqual(30);
  });
});

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A valid unified diff of 24k-50k characters: files of 1-3 hunks, each with
 * a context line and then a mix of added, context and deleted lines.
 */
function randomDiff(next: () => number): string {
  const int = (min: number, max: number) =>
    min + Math.floor(next() * (max - min + 1));
  const text = () =>
    Array.from({ length: int(3, 15) }, () =>
      "abcdefghijklmnopqrstuvwxyz".slice(0, int(2, 9))
    ).join(" ");
  const targetChars = int(24_000, 50_000);
  const files: string[] = [];
  let size = 0;
  for (let f = 0; size < targetChars; f++) {
    const path = `src/file${f}.ts`;
    const out = [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`
    ];
    let oldStart = 1;
    let newStart = 1;
    for (let h = int(1, 3); h > 0 && size < targetChars; h--) {
      const body = [` ${text()}`];
      let oldCount = 1;
      let newCount = 1;
      for (let n = int(5, 300); n > 0; n--) {
        const line = text();
        const kind = next();
        if (kind < 0.3) {
          body.push(` ${line}`);
          oldCount++;
          newCount++;
        } else if (kind < 0.9) {
          body.push(`+${line}`);
          newCount++;
        } else {
          body.push(`-${line}`);
          oldCount++;
        }
        size += line.length + 1;
      }
      out.push(
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        ...body
      );
      oldStart += oldCount + int(5, 50);
      newStart += newCount + int(5, 50);
    }
    files.push(out.join("\n"));
  }
  return `${files.join("\n")}\n`;
}
