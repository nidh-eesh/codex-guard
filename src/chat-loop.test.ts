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
  afterRefusal,
  chatStopWhen,
  latestToolOutcome,
  MAX_CHAT_STEPS,
  noToolCallsAsText,
  omitEmptyTools,
  refusalsThisTurn,
  RETRY_NOTE
} from "./chat-turn";
import { readRules, type RuleTables } from "./rule-changes";
import { ruleTools, toolErrorTexts } from "./rule-tools";
import type { CustomRule, DisabledDefault } from "./rules";
import { memoryUnapprovedCalls } from "./tool-approval";

// A replay of the loop seen in a live workspace: asked to "disable all
// rules", the model switched off the four unlocked rules, then alternated
// removeRule(no-secrets) (locked) and removeRule(validate-input) (already
// off), and every approval started a new turn. Now a call that would be
// refused never asks (D30), the model may fix a refused call once (D33),
// and after a second refusal the next step has no tools, so the model
// explains in words (D28).

const SYSTEM = "System prompt.";
const RETRYING = `${SYSTEM}\n\n${RETRY_NOTE}`;
const EXPLAINING = `${SYSTEM}\n\n${AFTER_REFUSAL_NOTE}`;

const UNLOCKED = [
  "validate-input",
  "no-sensitive-logs",
  "explicit-errors",
  "no-console-log"
];

function tablesWithOff(
  off: readonly string[],
  seeded: readonly CustomRule[] = []
): RuleTables {
  const custom: CustomRule[] = [...seeded];
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
function loopingModel(
  script: object[],
  toolName = "removeRule",
  noToolsReply = "That change was refused."
) {
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
          content: [{ type: "text", text: noToolsReply }],
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
            toolName,
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
  off: readonly string[] = UNLOCKED,
  {
    toolName = "removeRule",
    noToolsReply = "That change was refused.",
    custom = [] as CustomRule[],
    // As the server passes them: the IDs of the approved calls this turn runs
    pending = { removeRule: [] as string[], restoreRule: [] as string[] }
  } = {}
) {
  const tables = tablesWithOff(off, custom);
  const before = readRules(tables);
  const onChange = vi.fn();
  const tools = ruleTools(tables, memoryUnapprovedCalls(), onChange, {
    pending
  });
  const { model, offeredTools, systems } = loopingModel(
    script,
    toolName,
    noToolsReply
  );
  const result = streamText({
    model: wrapLanguageModel({
      model,
      middleware: [
        simulateStreamingMiddleware(),
        omitEmptyTools,
        noToolCallsAsText
      ]
    }),
    system: SYSTEM,
    messages,
    tools,
    stopWhen: chatStopWhen<typeof tools>(),
    prepareStep: afterRefusal<typeof tools>(SYSTEM)
  });
  const chunks: { type: string; errorText?: string; delta?: string }[] = [];
  const reader = result
    .toUIMessageStream({
      onError: toolErrorTexts(() => readRules(tables))
    })
    .getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(next.value as (typeof chunks)[number]);
  }
  return {
    offeredTools,
    systems,
    // A call the schema rejects streams as tool-input-error
    toolCalls: chunks.filter(
      (c) => c.type === "tool-input-available" || c.type === "tool-input-error"
    ).length,
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
function afterApproval(
  input: object,
  approved: boolean,
  toolName = "removeRule"
): ModelMessage[] {
  return [
    ...disableAll,
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "earlier-1",
          toolName,
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
  it("offers no removeRule once nothing can be removed, so the loop has nothing to call (D31)", async () => {
    // The live loop's state: the four unlocked rules are off, only locked
    // ones are on. The model calls removeRule anyway, and again when it may
    // fix the call
    const run = await turn(disableAll, [LOCKED, ALREADY_OFF]);
    // A call, one retry, then one step without tools, then the turn ends
    expect(run.offeredTools).toEqual([true, true, false]);
    expect(run.toolCalls).toBe(2);
    expect(run.askedForApproval).toBe(false);
    expect(run.errors).toEqual([
      "No rule can be switched off or deleted right now.",
      "No rule can be switched off or deleted right now."
    ]);
    expect(run.answer).toBe("That change was refused.");
    expect(run.rulesAfter).toEqual(run.rulesBefore);
    expect(run.onChange).not.toHaveBeenCalled();
    // The retry is told to read the error; the no-tools step is told why it
    // has no tools, so it explains instead of writing out a tool call
    expect(run.systems).toEqual([SYSTEM, RETRYING, EXPLAINING]);
  });

  it("refuses switching off a rule that's already off at once, and makes the model explain after its retry (D30)", async () => {
    // validate-input is off, so it's outside removeRule's list
    const run = await turn(
      disableAll,
      [ALREADY_OFF, LOCKED],
      ["validate-input"]
    );
    expect(run.offeredTools).toEqual([true, true, false]);
    expect(run.askedForApproval).toBe(false);
    expect(run.errors).toEqual([
      "Rule `validate-input` is already switched off.",
      LOCKED_REFUSAL
    ]);
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("refuses adding a duplicate straight away, with no card: the Random rule 2 chat (D30)", async () => {
    // This model repeats the same call when it may fix it
    const run = await turn(
      [{ role: "user", content: "Add a warning rule: Random rule 2" }],
      [{ rules: [{ text: "Random rule 2", severity: "warning" }] }],
      [],
      {
        toolName: "addRule",
        custom: [
          {
            id: "c_0000000a",
            text: "Random rule 2",
            severity: "warning",
            createdAt: 1
          }
        ]
      }
    );
    expect(run.askedForApproval).toBe(false);
    expect(run.errors).toEqual([
      "A rule with this text already exists.",
      "A rule with this text already exists."
    ]);
    expect(run.offeredTools).toEqual([true, true, false]);
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("lets the model fix a refused call, which then asks for approval: the 'Add 10 random rules' chat's first try (D33)", async () => {
    // Seen locally: ten rules named "Rule 1" to "Rule 10", all too short.
    // The model explained instead of writing longer ones
    const tooShort = {
      rules: Array.from({ length: 10 }, (_, i) => ({
        text: `Rule ${i + 1}`,
        severity: "warning"
      }))
    };
    const sentences = {
      rules: Array.from({ length: 10 }, (_, i) => ({
        text: `Code quality rule number ${i + 1}`,
        severity: "warning"
      }))
    };
    const run = await turn(
      [{ role: "user", content: "Add 10 random rules" }],
      [tooShort, sentences],
      [],
      { toolName: "addRule" }
    );
    expect(run.errors).toEqual([
      "Rule text must be between 10 and 200 characters."
    ]);
    // The retry keeps its tools and is told to read the error; the fixed
    // call waits for a person, like any other
    expect(run.offeredTools).toEqual([true, true]);
    expect(run.systems).toEqual([SYSTEM, RETRYING]);
    expect(run.askedForApproval).toBe(true);
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("lists the real IDs when the model invents some, so its retry can use them: the 'Remove all unlocked rules' chat", async () => {
    // Seen live: invented IDs rule1 to rule10, with an invented reason. The
    // retry names the real rules, but its reason is still made up
    const invented = {
      ruleIds: Array.from({ length: 10 }, (_, i) => `rule${i + 1}`),
      reason: "no reason provided"
    };
    const realIds = { ruleIds: UNLOCKED, reason: "no reason provided" };
    const run = await turn(
      [{ role: "user", content: "Remove all unlocked rules" }],
      [invented, realIds],
      []
    );
    expect(run.askedForApproval).toBe(false);
    const ids = invented.ruleIds.map((id) => `\`${id}\``).join(", ");
    expect(run.errors[0]).toBe(
      `No rules with IDs ${ids} exist in this workspace. Rules you can switch off: validate-input, no-sensitive-logs, explicit-errors, no-console-log.`
    );
    expect(run.errors[1]).toContain(
      "The reason must say why the team is switching this rule off"
    );
    // The no-tools step gets its own system text after the usual prompt
    expect(run.offeredTools).toEqual([true, true, false]);
    expect(run.systems[2]).toBe(
      "System prompt.\n\nYou can't call tools in this reply. Explain what happened and what the user can do next. Don't promise to do anything."
    );
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("after an approved call is refused, lets the model fix it once, then makes it explain", async () => {
    const run = await turn(
      afterApproval(ALREADY_OFF, true),
      [LOCKED, ALREADY_OFF],
      UNLOCKED,
      { pending: { removeRule: ALREADY_OFF.ruleIds, restoreRule: [] } }
    );
    expect(run.offeredTools).toEqual([true, false]);
    expect(run.toolCalls).toBe(1);
    expect(run.errors).toEqual([
      "Rule `validate-input` is already switched off.",
      LOCKED_REFUSAL
    ]);
    expect(run.answer).toBe("That change was refused.");
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("counts a refusal from before the approval, so the retry isn't reset by it (D33)", async () => {
    // The turn so far: a refused call, then a call a person approved. Both
    // answer the same user message, so the approved call's refusal is the
    // turn's second
    const [said, ...approval] = afterApproval(ALREADY_OFF, true);
    const refusedEarlier: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "first-1",
            toolName: "removeRule",
            input: LOCKED
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "first-1",
            toolName: "removeRule",
            output: { type: "error-text", value: LOCKED_REFUSAL }
          }
        ]
      }
    ];
    const run = await turn(
      [said, ...refusedEarlier, ...approval],
      [LOCKED],
      UNLOCKED,
      { pending: { removeRule: ALREADY_OFF.ruleIds, restoreRule: [] } }
    );
    expect(run.offeredTools).toEqual([false]);
    expect(run.systems).toEqual([EXPLAINING]);
    expect(run.toolCalls).toBe(0);
  });

  it("after a person rejects a call, gives the model no tools for its next step", async () => {
    const run = await turn(afterApproval(ALREADY_OFF, false), [
      ALREADY_OFF,
      LOCKED
    ]);
    expect(run.offeredTools).toEqual([false]);
    expect(run.systems).toEqual([EXPLAINING]);
    expect(run.toolCalls).toBe(0);
    expect(run.askedForApproval).toBe(false);
  });

  it("refuses a made-up reason without asking, then makes the model explain", async () => {
    const run = await turn(
      [{ role: "user", content: "Disable all rules. No reason." }],
      [MADE_UP_REASON],
      []
    );
    expect(run.offeredTools).toEqual([true, true, false]);
    expect(run.askedForApproval).toBe(false);
    expect(run.errors).toEqual([
      "The reason must say why the team is switching this rule off, in at least 10 characters.",
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
    expect(run.offeredTools).toEqual([true, true, false]);
    expect(run.askedForApproval).toBe(false);
    expect(run.errors).toHaveLength(2);
    for (const error of run.errors) {
      expect(error).toContain("The reason must be in the user's own words");
    }
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("rejects a call naming locked rules as a whole, before any of our code runs (D31)", async () => {
    const everyRule = {
      ruleIds: [...UNLOCKED, "no-secrets", "sql-parameterized"],
      reason: REASON
    };
    const run = await turn(disableAll, [everyRule], []);
    expect(run.askedForApproval).toBe(false);
    const refusal = `${LOCKED_REFUSAL} Rule \`sql-parameterized\` is locked and can't be switched off. Locked rules can't be changed; don't try again.`;
    expect(run.errors).toEqual([refusal, refusal]);
    expect(run.offeredTools).toEqual([true, true, false]);
    expect(run.rulesAfter).toEqual(run.rulesBefore);
  });

  it("switches off the four unlocked rules with one approval (D29, D31)", async () => {
    const fourRules = { ruleIds: UNLOCKED, reason: REASON };
    // The turn that asks: one call for all four rules, one approval
    const asking = await turn(disableAll, [fourRules], []);
    expect(asking.offeredTools).toEqual([true]);
    expect(asking.askedForApproval).toBe(true);
    // The turn after the approval: all four switched off
    const approved = await turn(
      afterApproval(fourRules, true),
      [fourRules],
      [],
      {
        pending: { removeRule: UNLOCKED, restoreRule: [] }
      }
    );
    expect(approved.rulesAfter.switchedOff.map((rule) => rule.id)).toEqual(
      UNLOCKED
    );
    expect(approved.onChange).toHaveBeenCalledTimes(1);
  });

  it("adds ten rules with one call and one approval: the 'Add 10 random rules' chat (D32)", async () => {
    const tenRules = {
      rules: Array.from({ length: 10 }, (_, i) => ({
        text: `Random rule ${i + 1}`,
        severity: i % 2 === 0 ? "error" : "warning"
      }))
    };
    const said: ModelMessage[] = [
      { role: "user", content: "Add 10 random rules" }
    ];
    // The turn that asks: one call for all ten, one card
    const asking = await turn(said, [tenRules], [], { toolName: "addRule" });
    expect(asking.offeredTools).toEqual([true]);
    expect(asking.toolCalls).toBe(1);
    expect(asking.askedForApproval).toBe(true);
    // After the approval all ten are added. This model then tries the same
    // call again, twice, as the live one did with rule 2: refused at once,
    // no card, and its written-out tool call never reaches the user
    const approved = await turn(
      [
        ...said.slice(0, 1),
        ...afterApproval(tenRules, true, "addRule").slice(1)
      ],
      [tenRules],
      [],
      {
        toolName: "addRule",
        noToolsReply:
          '{"name": "addRule", "parameters": {"text": "Random rule 8", "severity": "error"}}'
      }
    );
    expect(
      approved.rulesAfter.active.filter((rule) => rule.source === "custom")
    ).toHaveLength(10);
    expect(approved.onChange).toHaveBeenCalledTimes(1);
    expect(approved.askedForApproval).toBe(false);
    expect(approved.errors).toEqual([
      "A rule with this text already exists.",
      "A rule with this text already exists."
    ]);
    expect(approved.answer).toBe(
      "Nothing changed. A rule with this text already exists."
    );
  });

  it(`still stops at ${MAX_CHAT_STEPS} steps when every call succeeds`, async () => {
    const tools = ruleTools(
      tablesWithOff([]),
      memoryUnapprovedCalls(),
      () => {}
    );
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
      prepareStep: afterRefusal<typeof tools>(SYSTEM)
    });
    await result.consumeStream();
    expect(calls).toBe(MAX_CHAT_STEPS);
  });
});

describe("latestToolOutcome and refusalsThisTurn", () => {
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
  const refused = toolMessage({ type: "error-text", value: "Refused." });
  const succeeded = toolMessage({ type: "json", value: { ok: true } });
  const call: ModelMessage = { role: "assistant", content: "(a tool call)" };

  it("is refused after a failed call, and rejected after a person's Reject", () => {
    expect(latestToolOutcome([refused])).toBe("refused");
    expect(latestToolOutcome([toolMessage({ type: "execution-denied" })])).toBe(
      "rejected"
    );
  });

  it("is rejected when a step's results hold both a Reject and a refusal", () => {
    const both = {
      role: "tool",
      content: [
        ...(refused.content as object[]),
        {
          type: "tool-result",
          toolCallId: "c2",
          toolName: "addRule",
          output: { type: "execution-denied" }
        }
      ]
    } as ModelMessage;
    expect(latestToolOutcome([both])).toBe("rejected");
  });

  it("is refused after a batch change that refused any of its rules (D29)", () => {
    expect(
      latestToolOutcome([
        toolMessage({
          type: "json",
          value: {
            switchedOff: ["validate-input"],
            refused: [{ ruleId: "no-secrets" }]
          }
        })
      ])
    ).toBe("refused");
    expect(
      latestToolOutcome([
        toolMessage({
          type: "json",
          value: { switchedOff: ["validate-input"], refused: [] }
        })
      ])
    ).toBeUndefined();
  });

  it("is undefined after a successful call, or when the last message isn't a tool result", () => {
    expect(latestToolOutcome([succeeded])).toBeUndefined();
    expect(
      latestToolOutcome([
        refused,
        { role: "assistant", content: "Sorry, that was refused." }
      ])
    ).toBeUndefined();
    expect(latestToolOutcome([])).toBeUndefined();
  });

  it("counts refused steps since the user's latest message only", () => {
    const earlierTurn = [
      { role: "user", content: "Switch it off" } as ModelMessage,
      call,
      refused
    ];
    expect(refusalsThisTurn([])).toBe(0);
    expect(
      refusalsThisTurn([...earlierTurn, { role: "user", content: "Again" }])
    ).toBe(0);
    expect(
      refusalsThisTurn([
        ...earlierTurn,
        { role: "user", content: "Again" },
        call,
        refused,
        call,
        succeeded,
        call,
        refused
      ])
    ).toBe(2);
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
