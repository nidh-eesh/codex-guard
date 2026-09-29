import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  type LanguageModelMiddleware,
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepFunction,
  type StopCondition,
  type ToolSet,
  type UIMessage
} from "ai";
import { z } from "zod";
import type { ModelConfig } from "./model-config";
import { callNeurons } from "./review-cost";
import { stripReviewDetails } from "./review-summary";
import { RULE_TOOL_NAMES } from "./rule-tools";

/** How many of the latest messages the chat model sees each turn (D26). */
export const CHAT_HISTORY_MESSAGES = 10;

/**
 * The history sent to the chat model: the latest CHAT_HISTORY_MESSAGES
 * messages, each review reduced to its summary (D9). A tool call and its
 * result are parts of one message, so the cut never separates them.
 */
export function chatHistory(messages: readonly UIMessage[]): UIMessage[] {
  return stripReviewDetails(messages.slice(-CHAT_HISTORY_MESSAGES));
}

/**
 * What a chat turn cost, from the usage the model reported for each step
 * (D26). A count the model didn't report is charged as 0, as for reviews.
 */
export function chatTurnNeurons(
  model: ModelConfig,
  steps: readonly { usage: LanguageModelUsage }[]
): number {
  return steps.reduce(
    (sum, { usage }) =>
      sum + callNeurons(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0),
    0
  );
}

/** Most steps in one chat turn: room for a tool call and the answer after it. */
export const MAX_CHAT_STEPS = 5;

/** When a chat turn stops: at the step limit (D28 adds no other). */
export function chatStopWhen<TOOLS extends ToolSet>(): StopCondition<TOOLS> {
  return stepCountIs(MAX_CHAT_STEPS);
}

// Tool results that mean a call failed: a refused rule change, or a call
// the schema rejected
const FAILED_OUTPUTS = new Set(["error-text", "error-json"]);

type ToolOutput = { type: string; value?: unknown };

/** A batch rule change that applied some rules and refused others (D29). */
function hasRefusedItems(output: ToolOutput): boolean {
  if (output.type !== "json" || typeof output.value !== "object") return false;
  const refused = (output.value as { refused?: unknown } | null)?.refused;
  return Array.isArray(refused) && refused.length > 0;
}

const isRefused = (output: ToolOutput) =>
  FAILED_OUTPUTS.has(output.type) || hasRefusedItems(output);

/** The outputs of the tool results in a message, if it holds any. */
function outputsOf(message: ModelMessage | undefined): ToolOutput[] {
  if (message?.role !== "tool") return [];
  return message.content.flatMap((part) =>
    part.type === "tool-result" ? [part.output] : []
  );
}

/**
 * How the latest tool results went, when they are the last input message:
 * after a step in this turn and, at the first step after an approval, for
 * the approved calls that just ran. "rejected" if a person rejected any of
 * them, "refused" if any failed or a batch refused any of its rules.
 */
export function latestToolOutcome(
  messages: readonly ModelMessage[]
): "rejected" | "refused" | undefined {
  const outputs = outputsOf(messages.at(-1));
  if (outputs.some((output) => output.type === "execution-denied")) {
    return "rejected";
  }
  return outputs.some(isRefused) ? "refused" : undefined;
}

/**
 * How many steps since the user's latest message had a call refused,
 * approval continuations included: they answer the same message.
 */
export function refusalsThisTurn(messages: readonly ModelMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") break;
    if (outputsOf(messages[i]).some(isRefused)) count++;
  }
  return count;
}

/** Refused steps a turn may follow with a corrected call (D33). */
export const RETRIES_AFTER_REFUSAL = 1;

/** The system text for the step after a refusal the model may fix. */
export const RETRY_NOTE =
  "Your last call was refused. Read why. If you can fix the call, call the tool again with the fix. If the error says not to try again, or you need something from the user, don't call a tool: tell the user why in one sentence.";

/** The system text for the step after a rejection, or a refused retry. */
export const AFTER_REFUSAL_NOTE =
  "You can't call tools in this reply. Explain what happened and what the user can do next. Don't promise to do anything.";

/**
 * The step after a refused call keeps its tools, with a note to read the
 * error, so the model can fix the call: a longer text, the real IDs, fewer
 * rules (D33). A fixed call that needs approval asks as usual; one that
 * would be refused again is refused at once (D30). After the second refused
 * step since the user's message, or a person's Reject, the next step runs
 * with no tools and its own note, so the model explains in words (D28).
 * Without the note, Llama writes a tool call out as text, or promises to do
 * something it can't.
 */
export function afterRefusal<TOOLS extends ToolSet>(
  system: string
): PrepareStepFunction<TOOLS> {
  return ({ messages }) => {
    const outcome = latestToolOutcome(messages);
    if (outcome === undefined) return undefined;
    if (
      outcome === "refused" &&
      refusalsThisTurn(messages) <= RETRIES_AFTER_REFUSAL
    ) {
      return { system: `${system}\n\n${RETRY_NOTE}` };
    }
    return { activeTools: [], system: `${system}\n\n${AFTER_REFUSAL_NOTE}` };
  };
}

/**
 * A step with no active tools sends `tools: []`, which Workers AI rejects
 * ("`tools` must not be an empty array"). This leaves the field out instead,
 * so the step that explains a refusal can run.
 */
export const omitEmptyTools: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) =>
    params.tools?.length === 0
      ? { ...params, tools: undefined, toolChoice: undefined }
      : params
};

/**
 * The messages sent to the chat model: the latest 10 (D26), converted, with
 * the tool calls of earlier turns pruned to save tokens. The current turn's
 * calls, everything since the user's latest message, are kept: with them
 * pruned, the model couldn't see a rule it had just added, and added it
 * again (D32).
 */
export async function chatModelMessages(
  messages: readonly UIMessage[]
): Promise<ModelMessage[]> {
  const model = await convertToModelMessages(chatHistory(messages));
  let latestUser = model.length - 1;
  while (latestUser >= 0 && model[latestUser].role !== "user") latestUser--;
  if (latestUser <= 0) return model;
  return [
    ...pruneMessages({
      messages: model.slice(0, latestUser),
      toolCalls: "all"
    }),
    ...model.slice(latestUser)
  ];
}

// A rule tool call written out as JSON, as Llama writes one:
// {"name": "addRule", "parameters": {...}}, sometimes with "type":
// "function", or "arguments" for "parameters". Nothing else may be in it.
const callFields = {
  type: z.literal("function").optional(),
  name: z.enum(RULE_TOOL_NAMES)
};
const callArguments = z.record(z.string(), z.unknown());
const WrittenToolCall = z.union([
  z.strictObject({ ...callFields, parameters: callArguments }),
  z.strictObject({ ...callFields, arguments: callArguments })
]);

/**
 * Whether a reply is nothing but a call to one of the rule tools, as JSON.
 * Prose around it, a code example, or a call to any other name never
 * matches (D32).
 */
export function isWrittenToolCall(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return WrittenToolCall.safeParse(parsed).success;
}

/** Why the latest tool results didn't change anything, in their own words. */
function refusalsIn(prompt: readonly { role: string; content: unknown }[]) {
  const latest = [...prompt]
    .reverse()
    .find((message) => message.role === "tool");
  const parts = Array.isArray(latest?.content) ? latest.content : [];
  return parts.flatMap((part: { type?: string; output?: ToolOutput }) => {
    if (part.type !== "tool-result" || !part.output) return [];
    const { type, value } = part.output;
    if (type === "error-text" && typeof value === "string") return [value];
    if (type === "execution-denied") return ["The change was rejected."];
    const refused = (value as { refused?: { message?: unknown }[] } | undefined)
      ?.refused;
    return Array.isArray(refused)
      ? refused.flatMap((item) =>
          typeof item.message === "string" ? [item.message] : []
        )
      : [];
  });
}

/**
 * In a step with no tools, Llama sometimes writes a tool call out as text
 * instead of explaining, even when told not to (D32). A reply that is only
 * such a call is replaced with "Nothing changed." and the refusals it should
 * have explained, so the user never sees a raw call. Any other reply is
 * left as it is.
 */
export const noToolCallsAsText: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapGenerate: async ({ doGenerate, params }) => {
    const result = await doGenerate();
    if (params.tools?.length) return result;
    const text = result.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    if (!isWrittenToolCall(text)) return result;
    const reasons = [...new Set(refusalsIn(params.prompt))];
    return {
      ...result,
      content: [
        {
          type: "text",
          text: ["Nothing changed.", ...reasons].join(" ")
        }
      ]
    };
  }
};
