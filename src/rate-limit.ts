import { createUIMessageStream, createUIMessageStreamResponse } from "ai";

export const RATE_LIMITED_MESSAGE = "Too many requests. Try again in a minute.";

/** Where Cloudflare doesn't set a client IP (local development). */
export const UNKNOWN_IP = "unknown";

/** Kept on each connection: the client's IP, read once when the WebSocket connects. */
export interface ConnectionInfo {
  ip: string;
}

/** A request refused by a per-IP limit, with its DESIGN.md §5 message. */
export class RateLimitError extends Error {}

/** The client IP that Cloudflare sets on every request it forwards. */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? UNKNOWN_IP;
}

/** The IP stored on a connection, or UNKNOWN_IP for one without it. */
export function connectionIp(
  connection: { state?: unknown } | undefined
): string {
  const ip = (connection?.state as Partial<ConnectionInfo> | null | undefined)
    ?.ip;
  return typeof ip === "string" ? ip : UNKNOWN_IP;
}

/**
 * The key a per-IP limit counts under. An IPv6 client usually holds a whole
 * /64, so IPv6 addresses count per /64 prefix; an IPv4-mapped address counts
 * as its IPv4 address.
 */
export function rateLimitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const last = ip.slice(ip.lastIndexOf(":") + 1);
  if (last.includes(".")) return last;
  const [head, tail] = ip.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"),
          ...tailGroups
        ];
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, "") || "0");
  return `${prefix.join(":")}::/64`;
}

/** Counts a request against `limiter`; throws RateLimitError when over. */
export async function enforceRateLimit(
  limiter: RateLimit,
  ip: string
): Promise<void> {
  const { success } = await limiter.limit({ key: rateLimitKey(ip) });
  if (!success) throw new RateLimitError(RATE_LIMITED_MESSAGE);
}

/** A chat response that carries only an error, which the chat UI shows. */
export function chatErrorResponse(message: string): Response {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "error", errorText: message });
      }
    })
  });
}
