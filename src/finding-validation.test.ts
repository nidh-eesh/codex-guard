import { describe, expect, it } from "vitest";
import { validateFindings } from "./finding-validation";
import type { Chunk } from "./review-types";
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

// A snapshot without no-sensitive-logs: this workspace switched it off
const RULES = [
  rule("no-secrets", "error"),
  rule("validate-input", "error"),
  rule("no-console-log", "warning"),
  rule("c_1a2b3c4d", "warning", "custom")
];

const CHUNK: Chunk = {
  text: "(chunk text is not used by validation)",
  files: [
    { path: "src/api.ts", lines: [10, 11, 12, 20] },
    { path: "src/cli.ts", lines: [1, 2, 3] }
  ]
};

const valid = (fields: Record<string, unknown> = {}) => ({
  ruleId: "validate-input",
  file: "src/api.ts",
  line: 11,
  message: "The request body is used without validation.",
  suggestion: "Parse it with a schema first.",
  ...fields
});

const validate = (raw: unknown[]) => validateFindings(raw, CHUNK, RULES);

describe("validateFindings keeps", () => {
  it("a finding whose rule, file and line all check out", () => {
    expect(validate([valid()])).toEqual({
      findings: [valid()],
      dropped: 0,
      droppedForErrorRules: 0
    });
  });

  it("findings for any file and numbered line in the chunk", () => {
    const findings = [
      valid({ line: 10 }),
      valid({ line: 20 }),
      valid({ ruleId: "no-console-log", file: "src/cli.ts", line: 3 }),
      valid({ ruleId: "c_1a2b3c4d", file: "src/cli.ts", line: 1 })
    ];
    expect(validate(findings).findings).toEqual(findings);
  });

  it("every valid finding, even past the findings cap (D21)", () => {
    const many = Array.from({ length: 30 }, () => valid());
    expect(validate(many).findings).toHaveLength(30);
  });

  it("findings in the order given", () => {
    const a = valid({ line: 12 });
    const b = valid({ line: 10 });
    expect(validate([a, b]).findings).toEqual([a, b]);
  });

  it("a finding with an extra severity, without it (D10: severity comes from the rule)", () => {
    const [kept] = validate([valid({ severity: "warning" })]).findings;
    expect(kept).toEqual(valid());
    expect(kept).not.toHaveProperty("severity");
  });
});

describe("validateFindings drops", () => {
  it.each([
    ["an unknown rule", valid({ ruleId: "made-up-rule" })],
    ["a rule in the wrong case", valid({ ruleId: "Validate-Input" })],
    [
      "a starter rule the workspace switched off",
      valid({ ruleId: "no-sensitive-logs" })
    ],
    ["a file that isn't in the chunk", valid({ file: "src/other.ts" })],
    ["a line that isn't numbered in the chunk", valid({ line: 13 })],
    ["a line numbered only in another file", valid({ line: 1 })],
    ["line 0", valid({ line: 0 })],
    ["a negative line", valid({ line: -11 })],
    ["a fractional line", valid({ line: 11.5 })],
    ["a line given as a string", valid({ line: "11" })],
    ["a missing message", { ...valid(), message: undefined }],
    ["an empty message", valid({ message: "" })],
    ["a message of 10,000 characters", valid({ message: "x".repeat(10_000) })],
    ["a missing suggestion", { ...valid(), suggestion: undefined }],
    [
      "a suggestion of 10,000 characters",
      valid({ suggestion: "x".repeat(10_000) })
    ],
    ["a ruleId that isn't a string", valid({ ruleId: 42 })],
    ["a file that isn't a string", valid({ file: null })]
  ])("%s", (_case, finding) => {
    const result = validate([finding]);
    expect(result.findings).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it.each([
    ["null", null],
    ["a string", "validate-input at src/api.ts:11"],
    ["a number", 42],
    ["an array", ["validate-input", "src/api.ts", 11]]
  ])("an item that is %s", (_case, item) => {
    expect(validate([item])).toEqual({
      findings: [],
      dropped: 1,
      droppedForErrorRules: 0
    });
  });

  it.each([
    ["file", "toString"],
    ["file", "constructor"],
    ["file", "__proto__"],
    ["ruleId", "constructor"],
    ["ruleId", "hasOwnProperty"],
    ["ruleId", "__proto__"]
  ])(
    "a %s named %s: inherited property names aren't in the chunk or the rules",
    (field, name) => {
      expect(validate([valid({ [field]: name })]).findings).toEqual([]);
    }
  );
});

describe("validateFindings counts", () => {
  it("dropped findings for error rules, whatever else was wrong with them", () => {
    const result = validate([
      valid({ line: 13 }),
      valid({ file: "src/other.ts" }),
      valid({ ruleId: "no-secrets", line: "x" }),
      valid({ ruleId: "no-secrets", message: "" })
    ]);
    expect(result).toMatchObject({ dropped: 4, droppedForErrorRules: 4 });
  });

  it("dropped findings for warning rules and unknown rules as dropped only", () => {
    const result = validate([
      valid({ ruleId: "no-console-log", line: 99 }),
      valid({ ruleId: "made-up-rule" }),
      valid({ ruleId: "no-sensitive-logs" })
    ]);
    expect(result).toMatchObject({ dropped: 3, droppedForErrorRules: 0 });
  });

  it("kept and dropped findings in one answer", () => {
    const result = validate([
      valid(),
      valid({ line: 99 }),
      valid({ ruleId: "no-console-log", file: "src/cli.ts", line: 2 }),
      null
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result).toMatchObject({ dropped: 2, droppedForErrorRules: 1 });
  });
});

it("doesn't modify its inputs", () => {
  const raw = Object.freeze([Object.freeze(valid()), Object.freeze({ x: 1 })]);
  const before = structuredClone(raw);
  validate(raw as unknown[]);
  expect(raw).toEqual(before);
});

describe("validateFindings file paths", () => {
  it.each(["b/src/api.ts", "a/src/api.ts", "./src/api.ts"])(
    "accept %s by removing one leading prefix, keeping the chunk's path",
    (file) => {
      expect(validate([valid({ file })]).findings).toEqual([valid()]);
    }
  );

  it.each([
    ["two prefixes", "b/b/src/api.ts"],
    ["another prefix", "c/src/api.ts"],
    ["an absolute path", "/src/api.ts"],
    ["a prefix on a file that isn't in the chunk", "b/src/other.ts"]
  ])("drop a path with %s", (_case, file) => {
    expect(validate([valid({ file })]).findings).toEqual([]);
  });

  it("prefer an exact match, so a chunk file under b/ keeps its name", () => {
    const chunk: Chunk = {
      text: "",
      files: [
        { path: "b/x.ts", lines: [1] },
        { path: "x.ts", lines: [2] }
      ]
    };
    const [kept] = validateFindings(
      [valid({ file: "b/x.ts", line: 1 })],
      chunk,
      RULES
    ).findings;
    expect(kept.file).toBe("b/x.ts");
  });
});

describe("validateFindings text limits", () => {
  it.each(["message", "suggestion"])(
    "keep a %s of exactly 500 characters",
    (field) => {
      expect(
        validate([valid({ [field]: "x".repeat(500) })]).findings
      ).toHaveLength(1);
    }
  );

  it.each(["message", "suggestion"])("drop a %s of 501 characters", (field) => {
    expect(validate([valid({ [field]: "x".repeat(501) })]).findings).toEqual(
      []
    );
  });

  it("drop a whitespace-only message", () => {
    expect(validate([valid({ message: "  \n " })]).findings).toEqual([]);
  });
});
