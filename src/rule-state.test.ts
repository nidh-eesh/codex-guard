import { describe, expect, it } from "vitest";
import { rejectBrowserStateWrites } from "./rule-state";

describe("rejectBrowserStateWrites", () => {
  it("lets the server write state", () => {
    expect(() => rejectBrowserStateWrites("server")).not.toThrow();
  });

  it("rejects a write from a browser connection", () => {
    const connection = { id: "conn-1" };
    expect(() => rejectBrowserStateWrites(connection)).toThrow(
      "Rules state is written only by the server."
    );
  });
});
