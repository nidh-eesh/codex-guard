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
  chatTurnNeurons
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
