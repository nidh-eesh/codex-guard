import { DatabaseSync } from "node:sqlite";
import {
  convertToModelMessages,
  pruneMessages,
  type ModelMessage,
  type UIMessage
} from "ai";
import { describe, expect, it } from "vitest";
import type { Sql } from "./rule-tables";
import {
  approvedInLatestTurn,
  memoryUnapprovedCalls,
  sqliteUnapprovedCalls
} from "./tool-approval";

const user = (text: string): ModelMessage => ({ role: "user", content: text });

/** A call that asked for approval, and the person's answer to it. */
function answered(
  toolCallId: string,
  approved: boolean,
  approvalId = `approval-${toolCallId}`
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "removeRule",
          input: { ruleIds: ["no-console-log"] }
        },
        { type: "tool-approval-request", approvalId, toolCallId }
      ]
    },
    {
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId, approved }]
    }
  ];
}

describe("approvedInLatestTurn (D30)", () => {
  it("is true for a call approved in the latest assistant message", () => {
    const messages = [user("Switch it off"), ...answered("call-1", true)];
    expect(approvedInLatestTurn("call-1", messages)).toBe(true);
  });

  it("is false for a call that was rejected, or never asked", () => {
    expect(
      approvedInLatestTurn("call-1", [user("x"), ...answered("call-1", false)])
    ).toBe(false);
    expect(approvedInLatestTurn("call-1", [user("Switch it off")])).toBe(false);
    expect(approvedInLatestTurn("call-1", [])).toBe(false);
  });

  it("is false for another call's approval", () => {
    const messages = [user("x"), ...answered("call-2", true)];
    expect(approvedInLatestTurn("call-1", messages)).toBe(false);
  });

  it("ignores an approval from an older turn, even for the same call ID", () => {
    // Workers AI may reuse tool-call IDs across turns
    const messages = [
      user("Switch it off"),
      ...answered("call-1", true),
      user("Now switch the other one off")
    ];
    expect(approvedInLatestTurn("call-1", messages)).toBe(false);
  });

  it("ignores an approval once a later assistant message follows it", () => {
    const messages: ModelMessage[] = [
      user("x"),
      ...answered("call-1", true),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "removeRule",
            input: {}
          }
        ]
      }
    ];
    expect(approvedInLatestTurn("call-1", messages)).toBe(false);
  });

  it("reads an approval as the agent passes it: converted and pruned", async () => {
    const ui: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Switch off no-console-log" }]
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
          {
            type: "tool-removeRule",
            toolCallId: "call-1",
            state: "approval-responded",
            input: { ruleIds: ["no-console-log"], reason: "Our own logger" },
            approval: { id: "approval-1", approved: true }
          }
        ]
      }
    ] as UIMessage[];
    const messages = pruneMessages({
      messages: await convertToModelMessages(ui),
      toolCalls: "before-last-2-messages"
    });
    expect(approvedInLatestTurn("call-1", messages)).toBe(true);
    expect(approvedInLatestTurn("list-1", messages)).toBe(false);
  });
});

/** The agent's `sql` tag, over an in-memory SQLite database. */
function nodeSql(): Sql {
  const db = new DatabaseSync(":memory:");
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = db.prepare(strings.join("?"));
    return statement.columns().length > 0
      ? statement.all(...(values as never[]))
      : (statement.run(...(values as never[])), []);
  }) as Sql;
}

describe.each([
  ["in SQLite", () => sqliteUnapprovedCalls(nodeSql())],
  ["in memory", () => memoryUnapprovedCalls()]
])("the record of unapproved calls, %s (D30)", (_where, create) => {
  it("keeps a marked call until it's cleared", () => {
    const record = create();
    expect(record.has("call-1")).toBe(false);
    record.mark("call-1");
    record.mark("call-1");
    expect(record.has("call-1")).toBe(true);
    expect(record.has("call-2")).toBe(false);
    record.clear("call-1");
    expect(record.has("call-1")).toBe(false);
  });
});

it("forgets marks older than a day, when it next marks one", () => {
  let now = 0;
  const record = sqliteUnapprovedCalls(nodeSql(), () => now);
  record.mark("old");
  now = 24 * 60 * 60 * 1000 + 1;
  record.mark("new");
  expect(record.has("old")).toBe(false);
  expect(record.has("new")).toBe(true);
});
