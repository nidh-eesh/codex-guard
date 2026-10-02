import { isToolUIPart, type ChatStatus, type UIMessage } from "ai";

/** Where a tool call is, as its card in the chat shows it. */
export type ToolProgress =
  | "preparing"
  | "running"
  | "awaiting-approval"
  | "applying"
  | "done"
  | "rejected"
  | "failed";

/**
 * A tool call's progress from its part's state. "preparing" is the model
 * still writing the call, which now streams (D34); "applying" is an
 * approved call the server hasn't answered yet.
 */
export function toolProgress(part: {
  state: string;
  approval?: { approved?: boolean };
}): ToolProgress {
  switch (part.state) {
    case "input-streaming":
      return "preparing";
    case "approval-requested":
      return "awaiting-approval";
    case "approval-responded":
      return part.approval?.approved ? "applying" : "rejected";
    case "output-available":
      return "done";
    case "output-denied":
      return "rejected";
    case "output-error":
      return "failed";
    default:
      return "running";
  }
}

const FINISHED: ReadonlySet<ToolProgress> = new Set([
  "done",
  "rejected",
  "failed"
]);

/**
 * Whether the model is working with nothing of it on screen: after a
 * message is sent and before the first token, and between steps, once a
 * tool call has finished and before the next step's text. A tool card
 * that is still in progress shows its own state, and streaming text shows
 * itself.
 */
export function waitingForModel(
  status: ChatStatus,
  messages: readonly UIMessage[]
): boolean {
  if (status !== "submitted" && status !== "streaming") return false;
  const last = messages.at(-1);
  if (last?.role !== "assistant") return true;
  const shown = last.parts.filter((part) => part.type !== "step-start").at(-1);
  if (!shown) return true;
  if (isToolUIPart(shown)) return FINISHED.has(toolProgress(shown));
  if (shown.type === "text") return shown.text === "";
  return false;
}
