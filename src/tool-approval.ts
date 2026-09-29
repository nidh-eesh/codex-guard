import type { ModelMessage } from "ai";
import type { Sql } from "./rule-tables";

/**
 * Whether a person approved this tool call, going only by the latest
 * assistant message: its approval request for `toolCallId`, answered
 * approved in the tool messages right after it. Any other message after it,
 * such as the user's next one, starts a new turn, so an approval from an
 * older turn never counts, even if the model reuses the call's ID (D30).
 */
export function approvedInLatestTurn(
  toolCallId: string,
  messages: readonly ModelMessage[]
): boolean {
  let latest = messages.length - 1;
  while (latest >= 0 && messages[latest].role !== "assistant") latest--;
  if (latest < 0) return false;

  const after = messages.slice(latest + 1);
  if (after.some((message) => message.role !== "tool")) return false;

  const assistant = messages[latest];
  if (assistant.role !== "assistant" || typeof assistant.content === "string") {
    return false;
  }
  const approvalIds = new Set(
    assistant.content.flatMap((part) =>
      part.type === "tool-approval-request" && part.toolCallId === toolCallId
        ? [part.approvalId]
        : []
    )
  );
  return after.some(
    (message) =>
      message.role === "tool" &&
      message.content.some(
        (part) =>
          part.type === "tool-approval-response" &&
          part.approved === true &&
          approvalIds.has(part.approvalId)
      )
  );
}

/**
 * The server's own record of calls `needsApproval` let through without a
 * person, because they would be refused (D30). `execute` never writes for a
 * marked call, whatever the messages say. A call that waits for approval
 * clears its ID, in case the model reuses an ID it used before.
 */
export interface UnapprovedCalls {
  mark(toolCallId: string): void;
  clear(toolCallId: string): void;
  has(toolCallId: string): boolean;
}

/** How long a mark is kept: far longer than a call takes to run. */
const MARK_TTL_MS = 24 * 60 * 60 * 1000;

/** The record in the agent's SQLite database. Creating it is idempotent. */
export function sqliteUnapprovedCalls(
  sql: Sql,
  now: () => number = Date.now
): UnapprovedCalls {
  sql`CREATE TABLE IF NOT EXISTS unapproved_tool_calls (
    tool_call_id TEXT PRIMARY KEY,
    marked_at INTEGER NOT NULL
  )`;
  return {
    mark: (toolCallId) => {
      const at = now();
      sql`DELETE FROM unapproved_tool_calls WHERE marked_at < ${at - MARK_TTL_MS}`;
      sql`INSERT INTO unapproved_tool_calls (tool_call_id, marked_at)
        VALUES (${toolCallId}, ${at})
        ON CONFLICT (tool_call_id) DO UPDATE SET marked_at = excluded.marked_at`;
    },
    clear: (toolCallId) => {
      sql`DELETE FROM unapproved_tool_calls WHERE tool_call_id = ${toolCallId}`;
    },
    has: (toolCallId) =>
      sql`SELECT 1 FROM unapproved_tool_calls WHERE tool_call_id = ${toolCallId}`
        .length > 0
  };
}

/** The same record in memory, for tests. */
export function memoryUnapprovedCalls(): UnapprovedCalls {
  const marked = new Set<string>();
  return {
    mark: (toolCallId) => void marked.add(toolCallId),
    clear: (toolCallId) => void marked.delete(toolCallId),
    has: (toolCallId) => marked.has(toolCallId)
  };
}
