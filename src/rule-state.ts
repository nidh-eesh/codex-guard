import type { ResolvedRules } from "./rules";

/** Agent state before the rules are first read from SQLite. */
export const NO_RULES: ResolvedRules = { active: [], switchedOff: [] };

/**
 * Browsers receive the rules as agent state but never write it (DESIGN.md
 * §7, layer 6); the SDK calls this before it saves or broadcasts any change.
 * The SDK logs the error, so its message names no workspace data.
 */
export function rejectBrowserStateWrites(source: "server" | object): void {
  if (source !== "server") {
    throw new Error("Rules state is written only by the server.");
  }
}
