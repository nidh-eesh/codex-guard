import {
  simulateStreamingMiddleware,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel,
  type LanguageModelUsage,
  type UIMessage
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CHAT_HISTORY_MESSAGES,
  chatHistory,
  chatModelMessages,
  chatTurnNeurons,
  isWrittenToolCall,
  noToolCallsAsText
} from "./chat-turn";
import { MODEL } from "./model-config";
import { callNeurons } from "./review-cost";
import { REVIEW_PART, reviewMessage } from "./review-summary";

const text = (id: string): UIMessage => ({
  id,
  role: id.startsWith("u") ? "user" : "assistant",
  parts: [{ type: "text", text: id }]
});

const conversation = (n: number) =>
  Array.from({ length: n }, (_, i) => text(i % 2 === 0 ? `u${i}` : `a${i}`));

describe("chatHistory", () => {
  it("sends the model 10 messages", () => {
    expect(CHAT_HISTORY_MESSAGES).toBe(10);
  });

  it("keeps a conversation of 10 messages or fewer whole", () => {
    expect(chatHistory(conversation(10))).toEqual(conversation(10));
    expect(chatHistory(conversation(3))).toEqual(conversation(3));
    expect(chatHistory([])).toEqual([]);
  });

  it("keeps only the latest 10, in order", () => {
    const history = chatHistory(conversation(13));
    expect(history.map((m) => m.id)).toEqual(
      conversation(13)
        .slice(3)
        .map((m) => m.id)
    );
  });

  it("still strips review details inside the window (D9)", () => {
    const review = reviewMessage("wf-1", {
      verdict: "pass",
      findings: [],
      skipped: [],
      chunks: { total: 1, failed: 0 },
      droppedForErrorRules: 0,
      notes: []
    });
    const history = chatHistory([...conversation(12), review]);
    expect(history).toHaveLength(10);
    expect(history.at(-1)?.parts.some((p) => p.type === REVIEW_PART)).toBe(
      false
    );
  });
});

describe("chatTurnNeurons", () => {
  const usage = (
    inputTokens: number | undefined,
    outputTokens: number | undefined
  ): { usage: LanguageModelUsage } => ({
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }
    }
  });

  it("adds up every step of the turn", () => {
    expect(
      chatTurnNeurons(MODEL, [usage(2_000, 30), usage(2_400, 120)])
    ).toBeCloseTo(callNeurons(MODEL, 4_400, 150));
  });

  it("charges a count the model didn't report as 0", () => {
    expect(chatTurnNeurons(MODEL, [usage(undefined, 100)])).toBeCloseTo(
      callNeurons(MODEL, 0, 100)
    );
  });

  it("is nothing for a turn with no steps", () => {
    expect(chatTurnNeurons(MODEL, [])).toBe(0);
  });
});

describe("charging a turn in onFinish only (D26)", () => {
  const usage = {
    inputTokens: {
      total: 1_000,
      noCache: 1_000,
      cacheRead: undefined,
      cacheWrite: undefined
    },
    outputTokens: { total: 10, text: 10, reasoning: undefined }
  };

  // A tool call, then an answer, the way the agent calls the chat model.
  // stopDuringStep2 stops the turn while the second call is in flight.
  async function turn(stopDuringStep2: boolean) {
    const stop = new AbortController();
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async ({ abortSignal }) => {
        calls++;
        if (calls === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "listRules",
                input: "{}"
              }
            ],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage,
            warnings: []
          };
        }
        if (stopDuringStep2) {
          setTimeout(() => stop.abort(), 5);
          await new Promise((_, reject) =>
            abortSignal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("stopped"), { name: "AbortError" })
              )
            )
          );
        }
        return {
          content: [{ type: "text", text: "Done." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: []
        };
      }
    });
    const charges: number[] = [];
    const result = streamText({
      model: wrapLanguageModel({
        model,
        middleware: simulateStreamingMiddleware()
      }),
      prompt: "Which rules are locked?",
      tools: {
        listRules: tool({
          inputSchema: z.object({}),
          execute: async () => ({ active: [] })
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: stop.signal,
      onFinish: ({ steps }) => void charges.push(chatTurnNeurons(MODEL, steps))
    });
    const reader = result.toUIMessageStream().getReader();
    while (!(await reader.read()).done);
    return charges;
  }

  it("charges a finished turn once, for every step", async () => {
    expect(await turn(false)).toEqual([2 * callNeurons(MODEL, 1_000, 10)]);
  });

  it("charges a stopped turn once, for the steps it finished", async () => {
    // The ai package calls onFinish after onAbort when a step had finished,
    // so the agent doesn't charge in onAbort as well
    expect(await turn(true)).toEqual([callNeurons(MODEL, 1_000, 10)]);
  });
});

describe("chatModelMessages: the model sees its own turn (D32)", () => {
  const addPart = (n: number) => ({
    type: "tool-addRule",
    toolCallId: `add-${n}`,
    state: "output-available",
    input: { rules: [{ text: `Random rule ${n}`, severity: "error" }] },
    output: { added: [{ id: `c_0000000${n}`, text: `Random rule ${n}` }] }
  });
  const history = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Which rules are on?" }]
    },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-listRules",
          toolCallId: "list-1",
          state: "output-available",
          input: {},
          output: { active: [] }
        },
        { type: "step-start" },
        { type: "text", text: "Six rules are on." }
      ]
    },
    {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "Add 10 random rules" }]
    },
    {
      id: "a2",
      role: "assistant",
      parts: [1, 2, 3, 4].flatMap((n) => [{ type: "step-start" }, addPart(n)])
    }
  ] as UIMessage[];

  const calls = (messages: Awaited<ReturnType<typeof chatModelMessages>>) =>
    messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.flatMap((part) =>
            part.type === "tool-call" ? [part.toolName] : []
          )
    );

  it("keeps every call of the current turn, so the model sees the rules it added", async () => {
    // With them pruned, the model saw only its latest add, and added rule 2 again
    expect(calls(await chatModelMessages(history))).toEqual([
      "addRule",
      "addRule",
      "addRule",
      "addRule"
    ]);
  });

  it("prunes the calls of earlier turns, and keeps their text", async () => {
    const messages = await chatModelMessages(history);
    expect(calls(messages)).not.toContain("listRules");
    expect(JSON.stringify(messages)).toContain("Six rules are on.");
  });
});

describe("noToolCallsAsText (D32)", () => {
  const refusal = "A rule with this text already exists.";
  const prompt = (output: { type: string; value?: unknown }) => [
    { role: "user", content: [{ type: "text", text: "Add 10 random rules" }] },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c1", toolName: "addRule", output }
      ]
    }
  ];
  const reply = async (text: string, params: Record<string, unknown>) => {
    const result = await noToolCallsAsText.wrapGenerate!({
      doGenerate: async () =>
        ({
          content: [{ type: "text", text }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {},
          warnings: []
        }) as never,
      doStream: async () => {
        throw new Error("not used");
      },
      params: params as never,
      model: {} as never
    });
    return result.content
      .map((part) => ("text" in part ? part.text : ""))
      .join("");
  };

  it("replaces a tool call written out as text with the refusal: the Random rule 8 reply", async () => {
    const written =
      '{"name": "addRule", "parameters": {"text": "Random rule 8", "severity": "error"}}';
    expect(
      await reply(written, {
        prompt: prompt({ type: "error-text", value: refusal })
      })
    ).toBe(`Nothing changed. ${refusal}`);
  });

  it("catches a call written with its type, and names a rejection", async () => {
    const written =
      '\n{"type": "function", "name": "listRules", "parameters": {}}\n';
    expect(
      await reply(written, { prompt: prompt({ type: "execution-denied" }) })
    ).toBe("Nothing changed. The change was rejected.");
  });

  it("lists the refused rules of a batch that changed only some", async () => {
    const output = {
      type: "json",
      value: {
        added: [{}],
        refused: [{ text: "Random rule 2", message: refusal }]
      }
    };
    expect(
      await reply('{"name": "addRule", "arguments": {}}', {
        prompt: prompt(output)
      })
    ).toBe(`Nothing changed. ${refusal}`);
  });

  it("leaves a real explanation alone, and never touches a step that has tools", async () => {
    const explanation =
      "A rule with that text already exists, so it wasn't added.";
    expect(
      await reply(explanation, {
        prompt: prompt({ type: "error-text", value: refusal })
      })
    ).toBe(explanation);
    const written = '{"name": "addRule", "parameters": {}}';
    expect(
      await reply(written, {
        prompt: prompt({ type: "error-text", value: refusal }),
        tools: [{ type: "function", name: "addRule", inputSchema: {} }]
      })
    ).toBe(written);
  });

  it("leaves a normal reply with a code example alone, even one that shows a call", async () => {
    const withExample = [
      "Nothing was added: a rule with this text already exists. A call to add a different rule looks like this:",
      "```json",
      '{"name": "addRule", "parameters": {"rules": [{"text": "Functions stay under 50 lines", "severity": "warning"}]}}',
      "```"
    ].join("\n");
    expect(
      await reply(withExample, {
        prompt: prompt({ type: "error-text", value: refusal })
      })
    ).toBe(withExample);
  });
});

describe("isWrittenToolCall (D32)", () => {
  it.each([
    '{"name": "addRule", "parameters": {"rules": []}}',
    '{"name": "removeRule", "arguments": {"ruleIds": ["no-console-log"]}}',
    '{"type": "function", "name": "restoreRule", "parameters": {}}',
    '  {"name": "listRules", "parameters": {}}\n'
  ])("matches a reply that is only a rule tool call: %s", (text) => {
    expect(isWrittenToolCall(text)).toBe(true);
  });

  it.each([
    [
      "prose before a call",
      'Let me check. {"name": "listRules", "parameters": {}}'
    ],
    [
      "a call in a code block",
      '```json\n{"name": "listRules", "parameters": {}}\n```'
    ],
    ["another tool's name", '{"name": "deleteAllRules", "parameters": {}}'],
    [
      "a field a call doesn't have",
      '{"name": "addRule", "parameters": {}, "reason": "x"}'
    ],
    [
      "both argument fields",
      '{"name": "addRule", "parameters": {}, "arguments": {}}'
    ],
    ["no arguments", '{"name": "addRule"}'],
    [
      "arguments that aren't an object",
      '{"name": "addRule", "parameters": "rules"}'
    ],
    ["another type", '{"type": "tool", "name": "addRule", "parameters": {}}'],
    ["a list of calls", '[{"name": "addRule", "parameters": {}}]'],
    ["JSON that isn't a call", '{"rules": []}'],
    ["plain text", "Rule `no-secrets` is locked."],
    ["nothing", ""]
  ])("doesn't match %s", (_case, text) => {
    expect(isWrittenToolCall(text)).toBe(false);
  });
});
