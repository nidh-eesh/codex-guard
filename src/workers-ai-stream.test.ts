import { readFileSync } from "node:fs";
import { streamText, tool } from "ai";
import {
  convertArrayToReadableStream,
  convertReadableStreamToArray
} from "ai/test";
import { describe, expect, it } from "vitest";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { MODEL } from "./model-config";
import {
  singleCopy,
  singleCopyStream,
  singleCopyStreams
} from "./workers-ai-stream";

// Streams recorded from Workers AI's llama-3.3 through the binding, with
// only the random `p` padding field removed (D34)
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.sse`, import.meta.url), "utf8");

/** A recorded stream, delivered in pieces of `pieceSize` bytes. */
function recorded(name: string, pieceSize = Infinity) {
  const bytes = new TextEncoder().encode(fixture(name));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += pieceSize) {
        controller.enqueue(bytes.slice(at, at + pieceSize));
      }
      controller.close();
    }
  });
}

/** An AI binding whose `run` returns a recorded stream. */
const bindingFor = (name: string, pieceSize?: number) =>
  ({ run: async () => recorded(name, pieceSize) }) as unknown as Ai;

const HELLO = "Hello, team, I hope you're all doing well today.";

const tools = {
  listRules: tool({ inputSchema: z.object({}) }),
  addRule: tool({
    inputSchema: z.object({
      rules: z.array(
        z.object({ text: z.string(), severity: z.enum(["error", "warning"]) })
      )
    })
  })
};

/** One chat step through the real provider, as the agent streams it. */
async function step(binding: Ai) {
  const result = streamText({
    model: createWorkersAI({ binding })(MODEL.id),
    prompt: "Recorded.",
    tools
  });
  return {
    text: await result.text,
    toolCalls: (await result.toolCalls).map(({ toolName, input }) => ({
      toolName,
      input
    })),
    toolCallIds: (await result.toolCalls).map((call) => call.toolCallId),
    finishReason: await result.finishReason,
    usage: await result.usage
  };
}

describe("the provider bug this works around (D20)", () => {
  // If this starts failing, workers-ai-provider reads one copy itself
  // (cloudflare/ai#663), and singleCopyStreams can go
  it("still doubles streamed text and tool-call arguments without it", async () => {
    const doubledText = await step(bindingFor("llama-stream-text"));
    expect(doubledText.text).toContain("HelloHello");

    // The arguments don't parse, so the call keeps its raw text
    const doubled = await step(bindingFor("llama-stream-add-rule"));
    expect(doubled.toolCalls[0].input).toBeTypeOf("string");
    expect(doubled.toolCalls[0].input).toContain("FunctionsFunctions");
  });
});

describe("singleCopyStreams with the real provider (D34)", () => {
  it("streams a reply's text once, with the turn's usage", async () => {
    const run = await step(singleCopyStreams(bindingFor("llama-stream-text")));
    expect(run.text).toBe(HELLO);
    expect(run.finishReason).toBe("stop");
    // The last chunk carries the totals, which a turn is charged by (D26)
    expect(run.usage).toMatchObject({ inputTokens: 49, outputTokens: 14 });
  });

  it("streams a tool call whose arguments parse, with the model's call ID", async () => {
    const run = await step(
      singleCopyStreams(bindingFor("llama-stream-add-rule"))
    );
    expect(run.toolCalls).toEqual([
      {
        toolName: "addRule",
        input: {
          rules: [
            { text: "Functions stay under 50 lines", severity: "warning" }
          ]
        }
      }
    ]);
    expect(run.toolCallIds[0]).toContain("chatcmpl-tool-a6a503c8c21fb0e7");
    expect(run.text).toBe("");
    expect(run.finishReason).toBe("tool-calls");
    expect(run.usage).toMatchObject({ inputTokens: 339, outputTokens: 39 });
  });

  it("streams a call with no arguments", async () => {
    const run = await step(
      singleCopyStreams(bindingFor("llama-stream-list-rules"))
    );
    expect(run.toolCalls).toEqual([{ toolName: "listRules", input: {} }]);
  });

  it.each([1, 7, 64])(
    "reads the same however the bytes are split: pieces of %i",
    async (pieceSize) => {
      const text = await step(
        singleCopyStreams(bindingFor("llama-stream-text", pieceSize))
      );
      expect(text.text).toBe(HELLO);
      const call = await step(
        singleCopyStreams(bindingFor("llama-stream-add-rule", pieceSize))
      );
      expect(call.toolCalls).toHaveLength(1);
    }
  );

  it("passes a reply that isn't streamed through untouched", async () => {
    const reply = { response: "Hi", tool_calls: [] };
    const binding = singleCopyStreams({
      run: async () => reply
    } as unknown as Ai);
    expect(await binding.run(MODEL.id as never, {} as never)).toBe(reply);
  });

  it("keeps the binding's other methods working on the binding itself", () => {
    const binding = {
      name: "AI",
      describe() {
        return this.name;
      }
    };
    const wrapped = singleCopyStreams(binding as unknown as Ai) as unknown as {
      describe: () => string;
    };
    const { describe: unbound } = wrapped;
    expect(unbound()).toBe("AI");
  });
});

describe("singleCopy (D34)", () => {
  it("drops the native text when the delta carries it", () => {
    expect(
      singleCopy({ response: "Hi", choices: [{ delta: { content: "Hi" } }] })
    ).toEqual({ choices: [{ delta: { content: "Hi" } }] });
  });

  it("drops the native tool calls when the delta carries them", () => {
    const delta = {
      tool_calls: [{ index: 0, function: { arguments: " 50" } }]
    };
    expect(
      singleCopy({ tool_calls: [{ arguments: 50 }], choices: [{ delta }] })
    ).toEqual({ choices: [{ delta }] });
  });

  it("keeps a native copy that is the only one", () => {
    const primingWithText = {
      response: "Hi",
      choices: [{ delta: { content: "", role: "assistant" } }]
    };
    expect(singleCopy(primingWithText)).toEqual(primingWithText);
    const nativeOnly = { response: "Hi", tool_calls: [{ name: "addRule" }] };
    expect(singleCopy(nativeOnly)).toEqual(nativeOnly);
    const totals = { response: "", usage: { prompt_tokens: 49 } };
    expect(singleCopy(totals)).toEqual(totals);
  });
});

describe("singleCopyStream (D34)", () => {
  const rewrite = async (text: string) => {
    const out = convertArrayToReadableStream([
      new TextEncoder().encode(text)
    ]).pipeThrough(singleCopyStream());
    const decoder = new TextDecoder();
    return (await convertReadableStreamToArray(out))
      .map((piece) => decoder.decode(piece))
      .join("");
  };

  it("rewrites data lines and passes every other line through", async () => {
    const chunk = { response: "Hi", choices: [{ delta: { content: "Hi" } }] };
    expect(
      await rewrite(
        `: comment\ndata: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
      )
    ).toBe(
      `: comment\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n`
    );
  });

  it("rewrites a last line that has no newline", async () => {
    expect(await rewrite('data: {"response":"Hi","tool_calls":[]}')).toBe(
      'data: {"response":"Hi","tool_calls":[]}'
    );
  });
});
