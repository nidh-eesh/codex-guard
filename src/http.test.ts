import { describe, expect, it } from "vitest";
import { withReferrerPolicy } from "./http";

describe("withReferrerPolicy", () => {
  it("adds Referrer-Policy: no-referrer", () => {
    const response = withReferrerPolicy(new Response("ok"));
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("keeps the status, body and other headers", async () => {
    const response = withReferrerPolicy(
      new Response("This workspace link is invalid.", {
        status: 400,
        headers: { "Content-Type": "text/plain" }
      })
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(await response.text()).toBe("This workspace link is invalid.");
  });

  it("overrides a looser policy set upstream", () => {
    const response = withReferrerPolicy(
      new Response("ok", { headers: { "Referrer-Policy": "unsafe-url" } })
    );
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("passes a WebSocket upgrade through untouched", () => {
    // Node can't construct a 101 Response, so a stand-in carries the status
    const upgrade = { status: 101 } as Response;
    expect(withReferrerPolicy(upgrade)).toBe(upgrade);
  });
});
