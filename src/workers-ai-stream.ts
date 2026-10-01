/**
 * Workers AI streams each llama-3.3 delta twice in one chunk: in the native
 * fields (`response`, `tool_calls`) and in `choices[0].delta`.
 * workers-ai-provider 3.3.1 reads both, so streamed text came out doubled
 * and tool-call arguments stopped being JSON (D20). This rewrites the stream
 * before the provider reads it, keeping one copy of each delta (D34). When
 * the provider is fixed (cloudflare/ai#663), the native copies are already
 * ignored and this changes nothing.
 */

type StreamChunk = {
  response?: unknown;
  tool_calls?: unknown;
  choices?: { delta?: { content?: unknown; tool_calls?: unknown } | null }[];
};

/**
 * One chunk with its native copies dropped wherever `choices[0].delta`
 * carries the same payload. The delta's copy is the one kept: its tool
 * calls have an `id` and an `index`, and its arguments are the text the
 * model wrote, where the native copy turns `" 50"` into `50`. An empty
 * delta doesn't count as a copy, so a sole native copy is never dropped.
 */
export function singleCopy(chunk: StreamChunk): StreamChunk {
  const delta = chunk.choices?.[0]?.delta;
  const kept = { ...chunk };
  if (typeof delta?.content === "string" && delta.content !== "") {
    delete kept.response;
  }
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    delete kept.tool_calls;
  }
  return kept;
}

/** An SSE line, with a JSON `data:` payload rewritten by `singleCopy`. */
function singleCopyLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return line;
  let chunk: unknown;
  try {
    chunk = JSON.parse(trimmed.slice("data:".length));
  } catch {
    // "[DONE]", or anything else that isn't JSON, passes through as it is
    return line;
  }
  if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) {
    return line;
  }
  return `data: ${JSON.stringify(singleCopy(chunk))}`;
}

/**
 * Rewrites a Workers AI SSE byte stream line by line, as the provider reads
 * it, holding back only a line that hasn't ended yet.
 */
export function singleCopyStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let partial = "";
  return new TransformStream({
    transform(bytes, controller) {
      const lines = (partial + decoder.decode(bytes, { stream: true })).split(
        "\n"
      );
      partial = lines.pop() ?? "";
      if (lines.length === 0) return;
      controller.enqueue(
        encoder.encode(
          lines.map((line) => `${singleCopyLine(line)}\n`).join("")
        )
      );
    },
    flush(controller) {
      const rest = partial + decoder.decode();
      if (rest) controller.enqueue(encoder.encode(singleCopyLine(rest)));
    }
  });
}

/**
 * The AI binding, with every streamed reply passed through
 * `singleCopyStream` before workers-ai-provider reads it (D34). Everything
 * else, including replies that aren't streamed, passes through untouched.
 */
export function singleCopyStreams(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (property !== "run") return value.bind(target);
      return async (...args: unknown[]) => {
        const result: unknown = await value.apply(target, args);
        return result instanceof ReadableStream
          ? result.pipeThrough(singleCopyStream())
          : result;
      };
    }
  });
}
