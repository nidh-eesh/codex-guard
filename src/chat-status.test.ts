import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { toolProgress, waitingForModel } from "./chat-status";

describe("toolProgress", () => {
  it.each([
    [{ state: "input-streaming" }, "preparing"],
    [{ state: "input-available" }, "running"],
    [{ state: "approval-requested" }, "awaiting-approval"],
    [{ state: "approval-responded", approval: { approved: true } }, "applying"],
    [
      { state: "approval-responded", approval: { approved: false } },
      "rejected"
    ],
    [{ state: "output-available" }, "done"],
    [{ state: "output-denied" }, "rejected"],
    [{ state: "output-error" }, "failed"]
  ])("reads %o as %s", (part, progress) => {
    expect(toolProgress(part)).toBe(progress);
  });
});

describe("waitingForModel", () => {
  const user: UIMessage = {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "Which rules are on?" }]
  };
  const assistant = (...parts: object[]): UIMessage =>
    ({ id: "a1", role: "assistant", parts }) as UIMessage;
  const tool = (state: string, extra: object = {}) => ({
    type: "tool-listRules",
    toolCallId: "c1",
    state,
    input: {},
    ...extra
  });

  it("is true once a message is sent, before anything comes back", () => {
    expect(waitingForModel("submitted", [user])).toBe(true);
    expect(waitingForModel("streaming", [user])).toBe(true);
    expect(
      waitingForModel("streaming", [user, assistant({ type: "step-start" })])
    ).toBe(true);
  });

  it("is true between steps, after a tool call has finished", () => {
    const listed = assistant(
      { type: "step-start" },
      tool("output-available", { output: {} }),
      { type: "step-start" }
    );
    expect(waitingForModel("streaming", [user, listed])).toBe(true);
  });

  it("is false while a tool card or text shows the progress itself", () => {
    expect(
      waitingForModel("streaming", [user, assistant(tool("input-streaming"))])
    ).toBe(false);
    const applying = tool("approval-responded", {
      approval: { id: "x", approved: true }
    });
    expect(waitingForModel("submitted", [user, assistant(applying)])).toBe(
      false
    );
    expect(
      waitingForModel("streaming", [
        user,
        assistant({ type: "text", text: "Two rules" })
      ])
    ).toBe(false);
  });

  it("is true for a text part that has no text yet", () => {
    expect(
      waitingForModel("streaming", [
        user,
        assistant({ type: "text", text: "" })
      ])
    ).toBe(true);
  });

  it("is false when nothing is running", () => {
    expect(waitingForModel("ready", [user])).toBe(false);
    expect(waitingForModel("error", [user])).toBe(false);
  });
});
