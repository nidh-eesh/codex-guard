import {
  simulateStreamingMiddleware,
  streamText,
  wrapLanguageModel,
  type ModelMessage
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import {
  AFTER_REFUSAL_NOTE,
  chatStopWhen,
  explainAfterRefusal,
  lastCallRefused,
  MAX_CHAT_STEPS,
  omitEmptyTools
} from "./chat-turn";
import { readRules, ruleChangePreview, type RuleTables } from "./rule-changes";
import { ruleTools, toolErrorText } from "./rule-tools";
import type { CustomRule, DisabledDefault } from "./rules";

// A replay of the loop seen in a live workspace: asked to "disable all
// rules", the model switched off the four unlocked rules, then alternated
// removeRule(no-secrets) (locked) and removeRule(validate-input) (already
// off), and every approval started a new turn. Now a refused call is never
// retried: the next step has no tools, so the model explains in words (D28).

const UNLOCKED = [
  "validate-input",
  "no-sensitive-logs",
  "explicit-errors",
  "no-console-log"
];

function tablesWithOff(off: readonly string[]): RuleTables {
  const custom: CustomRule[] = [];
  let disabled: DisabledDefault[] = off.map((ruleId) => ({
    ruleId,
    reason: "Covered by our own linting",
    ruleText: "",
    disabledAt: 1
  }));
  return {
    customRules: () => [...custom],
    disabledDefaults: () => [...disabled],
    insertCustomRule: (rule) => void custom.push(rule),
    deleteCustomRule: () => {},
    insertDisabledDefault: (row) => void disabled.push(row),
    deleteDisabledDefault: (ruleId) =>
      void (disabled = disabled.filter((r) => r.ruleId !== ruleId))
  };
}

// The user gives this reason, so only the rules decide the switch-offs below
const REASON = "Covered by our own linting";
const LOCKED = { ruleIds: ["no-secrets"], reason: REASON };
const ALREADY_OFF = { ruleIds: ["validate-input"], reason: REASON };
const MADE_UP_REASON = { ruleIds: ["no-console-log"], reason: "No reason" };

const LOCKED_REFUSAL =
  "Rule `no-secrets` is locked and can't be switched off. Locked rules can't be changed; don't try again.";

const usage = {
  inputTokens: {
    total: 1_000,
    noCache: 1_000,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined }
};

/**
 * The live model's habit: whenever it has tools, it calls removeRule,
 * cycling through `script`. With no tools, it can only answer in words.
 */
function loopingModel(script: object[]) {
  const offeredTools: boolean[] = [];
  const systems: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async ({ tools, prompt }) => {
      const system = prompt.find((message) => message.role === "system");
      systems.push(typeof system?.content === "string" ? system.content : "");
      // Workers AI's own check: an empty list is refused, not ignored
      if (tools?.length === 0) {
        throw new Error("`tools` must not be an empty array");
      }
      const hasTools = (tools ?? []).length > 0;
      offeredTools.push(hasTools);
      if (!hasTools) {
        return {
          content: [{ type: "text", text: "That change was refused." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: []
        };
      }
      const toolCalls = offeredTools.filter(Boolean).length;
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `loop-${toolCalls}`,
            toolName: "removeRule",
            input: JSON.stringify(script[(toolCalls - 1) % script.length])
          }
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: []
      };
    }
  });
  return { model, offeredTools, systems };
}

/** One chat turn, configured as the agent configures it. */
async function turn(
  messages: ModelMessage[],
  script: object[],
  off: readonly string[] = UNLOCKED
) {
  const tables = tablesWithOff(off);
  const before = readRules(tables);
  const onChange = vi.fn();
  const tools = ruleTools(tables, onChange);
  const { model, offeredTools, systems } = loopingModel(script);
  const result = streamText({
    model: wrapLanguageModel({
      model,
      middleware: [simulateStreamingMiddleware(), omitEmptyTools]
    }),
    system: "System prompt.",
    messages,
    tools,
    stopWhen: chatStopWhen<typeof tools>(),
    prepareStep: explainAfterRefusal<typeof tools>("System prompt.")
  });
  const chunks: { type: string; errorText?: string; delta?: string }[] = [];
  const reader = result
    .toUIMessageStream({ onError: toolErrorText })
    .getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(next.value as (typeof chunks)[number]);
  }
  return {
    offeredTools,
    systems,
    toolCalls: chunks.filter((c) => c.type === "tool-input-available").length,
    errors: chunks
      .filter((c) => c.type === "tool-output-error")
      .map((c) => c.errorText),
    askedForApproval: chunks.some((c) => c.type === "tool-approval-request"),
    answer: chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.delta)
      .join(""),
    rulesBefore: before,
    rulesAfter: readRules(tables),
    onChange
  };
}

const disableAll: ModelMessage[] = [
  { role: "user", content: `Disable all rules. ${REASON}.` }
];

/** The turn after a person answered an approval for `input`. */
function afterApproval(input: object, approved: boolean): ModelMessage[] {
  return [
    ...disableAll,
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "earlier-1",
          toolName: "removeRule",
          input
        },
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCallId: "earlier-1"
        }
      ]
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: "approval-1",
          approved
        }
      ]
    }
  ];
}

describe("the disable-all loop, replayed (D28)", () => {
  it("refuses the locked rule without asking, then makes the model explain with no tools", async () => {
    const run = await turn(disableAll, [LOCKED, ALREADY_OFF]);
    // One tool call, then one step without tools, then the turn ends
    expect(run.offeredTools).toEqual([true, false]);
    expect(run.toolCalls).toBe(1);
    expect(run.askedForApproval).toBe(false);
    expect(run.errors).toEqual([LOCKED_REFUSAL]);
    expect(run.answer).toBe("That change was refused.");
    expect(run.rulesAfter).toEqual(run.rulesBefore);
    expect(run.onChange).not.toHaveBeenCalled();
    // The no-tools step is told why, so it explains instead of writing out
    // a tool call
    expect(run.systems).toEqual([
      "System prompt.",
      `System prompt.\n\n${AFTER_REFUSAL_NOTE}`
    ]);
  });

  it("asks a person before the change that depends on the rules, and the card warns it will be refused", async () => {
    const run = await turn(disableAll, [ALREADY_OFF, LOCKED]);
    expect(run.offeredTools).toEqual([true]);
    expect(run.askedForApproval).toBe(true);
    expect(run.errors).toEqual([]);
    expect(
      ruleChangePreview("removeRule", ALREADY_OFF, run.rulesBefore)
    ).toEqual({
      refusals: ["Rule `validate-input` is already switched off."],
      allRefused: true
    });
  });

  it("after an approved call is refused, gives the model no tools for its next step", async () => {
    const run = await turn(afterApproval(ALREADY_OFF, true), [
      LOCKED,
      ALREADY_OFF
    ]);
    expect(run.offeredTools).toEqual([false]);
    expect(run.toolCalls).toBe(0);
    expect(run.errors).toEqual([
      "Rule `validate-input` is already switched off."
    ]);
    expect(run.answer).toBe("That change was refused.");
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("after a person rejects a call, gives the model no tools for its next step", async () => {
    const run = await turn(afterApproval(ALREADY_OFF, false), [
      ALREADY_OFF,
      LOCKED
    ]);
    expect(run.offeredTools).toEqual([false]);
    expect(run.toolCalls).toBe(0);
    expect(run.askedForApproval).toBe(false);
  });

  it("refuses a made-up reason without asking, then makes the model explain", async () => {
    const run = await turn(
      [{ role: "user", content: "Disable all rules. No reason." }],
      [MADE_UP_REASON],
      []
    );
    expect(run.offeredTools).toEqual([true, false]);
    expect(run.askedForApproval).toBe(false);
    expect(run.errors).toEqual([
      "The reason must say why the team is switching this rule off, in at least 10 characters."
    ]);
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("refuses the local incident's invented reason without asking (D28)", async () => {
    // Asked to disable all rules with no reason given, the model made one up,
    // and a person approved it 4 times. Now no approval is asked for.
    const invented = {
      ruleIds: UNLOCKED,
      reason: "This rule is not necessary for our project"
    };
    const run = await turn(
      [{ role: "user", content: "Disable all rules" }],
      [invented],
      []
    );
    expect(run.offeredTools).toEqual([true, false]);
    expect(run.askedForApproval).toBe(false);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toContain(
      "The reason must be in the user's own words"
    );
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("switches off every unlocked rule with one approval, then explains the locked ones (D29)", async () => {
    const everyRule = {
      ruleIds: [...UNLOCKED, "no-secrets", "sql-parameterized"],
      reason: REASON
    };
    // The turn that asks: one call for all six rules, one approval
    const asking = await turn(disableAll, [everyRule], []);
    expect(asking.offeredTools).toEqual([true]);
    expect(asking.askedForApproval).toBe(true);
    // The turn after the approval: four switched off, two refused as
    // locked, and the model explains with no tools
    const approved = await turn(
      afterApproval(everyRule, true),
      [everyRule],
      []
    );
    expect(approved.offeredTools).toEqual([false]);
    expect(approved.toolCalls).toBe(0);
    expect(approved.askedForApproval).toBe(false);
    expect(approved.rulesAfter.switchedOff.map((rule) => rule.id)).toEqual(
      UNLOCKED
    );
    expect(approved.onChange).toHaveBeenCalledTimes(1);
  });

  it(`still stops at ${MAX_CHAT_STEPS} steps when every call succeeds`, async () => {
    const tools = ruleTools(tablesWithOff([]), () => {});
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls++;
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `list-${calls}`,
              toolName: "listRules",
              input: "{}"
            }
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage,
          warnings: []
        };
      }
    });
    const result = streamText({
      model: wrapLanguageModel({
        model,
        middleware: [simulateStreamingMiddleware(), omitEmptyTools]
      }),
      prompt: "Which rules are on?",
      tools,
      stopWhen: chatStopWhen<typeof tools>(),
      prepareStep: explainAfterRefusal<typeof tools>("System prompt.")
    });
    await result.consumeStream();
    expect(calls).toBe(MAX_CHAT_STEPS);
  });
});

describe("lastCallRefused", () => {
  const toolMessage = (output: {
    type: string;
    value?: unknown;
  }): ModelMessage =>
    ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "removeRule",
          output
        }
      ]
    }) as ModelMessage;

  it("is true after a failed call or a rejected one", () => {
    expect(
      lastCallRefused([toolMessage({ type: "error-text", value: "Refused." })])
    ).toBe(true);
    expect(lastCallRefused([toolMessage({ type: "execution-denied" })])).toBe(
      true
    );
  });

  it("is true after a batch change that refused any of its rules (D29)", () => {
    expect(
      lastCallRefused([
        toolMessage({
          type: "json",
          value: {
            switchedOff: ["validate-input"],
            refused: [{ ruleId: "no-secrets" }]
          }
        })
      ])
    ).toBe(true);
    expect(
      lastCallRefused([
        toolMessage({
          type: "json",
          value: { switchedOff: ["validate-input"], refused: [] }
        })
      ])
    ).toBe(false);
  });

  it("is false after a successful call, or when the last message isn't a tool result", () => {
    expect(
      lastCallRefused([toolMessage({ type: "json", value: { ok: true } })])
    ).toBe(false);
    expect(
      lastCallRefused([
        toolMessage({ type: "error-text", value: "Refused." }),
        { role: "assistant", content: "Sorry, that was refused." }
      ])
    ).toBe(false);
    expect(lastCallRefused([])).toBe(false);
  });
});

describe("omitEmptyTools", () => {
  const transform = omitEmptyTools.transformParams!;
  const call = (tools: unknown) =>
    transform({
      type: "generate",
      params: { prompt: [], tools, toolChoice: { type: "auto" } } as never,
      model: {} as never
    });

  it("leaves out an empty tool list and its tool choice, which Workers AI rejects", async () => {
    expect(await call([])).toMatchObject({
      tools: undefined,
      toolChoice: undefined
    });
  });

  it("passes a real tool list through", async () => {
    const tools = [{ type: "function", name: "listRules", inputSchema: {} }];
    expect(await call(tools)).toMatchObject({
      tools,
      toolChoice: { type: "auto" }
    });
  });
});
