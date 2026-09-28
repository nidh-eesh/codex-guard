import type { UIMessageChunk } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  chatErrorResponse,
  clientIp,
  connectionIp,
  enforceRateLimit,
  RateLimitError,
  rateLimitKey
} from "./rate-limit";

describe("clientIp", () => {
  it("reads the IP Cloudflare sets", () => {
    const request = new Request("https://example.com", {
      headers: { "CF-Connecting-IP": "203.0.113.7" }
    });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("falls back to one shared key where there's none (local development)", () => {
    expect(clientIp(new Request("https://example.com"))).toBe("unknown");
  });
});

describe("connectionIp", () => {
  it("reads the IP stored when the WebSocket connected", () => {
    expect(connectionIp({ state: { ip: "203.0.113.7" } })).toBe("203.0.113.7");
  });

  it.each([
    ["no connection", undefined],
    ["no state", { state: null }],
    ["state without an IP", { state: { other: 1 } }],
    ["an IP that isn't a string", { state: { ip: 42 } }]
  ])("falls back to the shared key for %s", (_case, connection) => {
    expect(connectionIp(connection)).toBe("unknown");
  });
});

describe("rateLimitKey", () => {
  it.each([
    ["an IPv4 address", "203.0.113.7", "203.0.113.7"],
    [
      "a full IPv6 address, by its /64",
      "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      "2001:db8:85a3:0::/64"
    ],
    [
      "another address in the same /64",
      "2001:db8:85a3:0:ffff:ffff:ffff:1",
      "2001:db8:85a3:0::/64"
    ],
    ["a compressed IPv6 address", "2001:db8::1", "2001:db8:0:0::/64"],
    ["IPv6 loopback", "::1", "0:0:0:0::/64"],
    ["uppercase IPv6", "2001:DB8:ABCD:12::1", "2001:db8:abcd:12::/64"],
    ["an IPv4-mapped IPv6 address", "::ffff:203.0.113.7", "203.0.113.7"],
    ["the shared fallback", "unknown", "unknown"]
  ])("keys %s", (_case, ip, key) => {
    expect(rateLimitKey(ip)).toBe(key);
  });
});

describe("enforceRateLimit", () => {
  const limiter = (success: boolean) => ({
    limit: vi.fn(async () => ({ success }))
  });

  it("counts the request under the IP's key and lets it through", async () => {
    const allowing = limiter(true);
    await enforceRateLimit(allowing, "2001:db8::1");
    expect(allowing.limit).toHaveBeenCalledWith({ key: "2001:db8:0:0::/64" });
  });

  it("refuses with the DESIGN.md §5 message when over the limit", async () => {
    const refusal = enforceRateLimit(limiter(false), "203.0.113.7");
    await expect(refusal).rejects.toBeInstanceOf(RateLimitError);
    await expect(refusal).rejects.toThrow(
      "Too many requests. Try again in a minute."
    );
  });
});

describe("chatErrorResponse", () => {
  it("streams one error chunk carrying the message", async () => {
    const response = chatErrorResponse(
      "Too many requests. Try again in a minute."
    );
    const chunks: UIMessageChunk[] = [];
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += value;
    }
    for (const line of text.split("\n")) {
      if (line.startsWith("data: {")) chunks.push(JSON.parse(line.slice(6)));
    }
    expect(chunks).toContainEqual({
      type: "error",
      errorText: "Too many requests. Try again in a minute."
    });
    // It carries no assistant text for the chat to keep
    expect(chunks.some((c) => c.type === "text-delta")).toBe(false);
  });
});
