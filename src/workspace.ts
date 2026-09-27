import { z } from "zod";

export const INVALID_WORKSPACE_MESSAGE = "This workspace link is invalid.";

/**
 * A workspace ID is a random (v4) UUID, and lowercase is its only accepted
 * form. Durable Object names are case-sensitive, so `ABC…` and `abc…` would be
 * two different workspaces. The router hooks run after the SDK has read the
 * instance name from the URL and can't change it, so the server rejects
 * anything else; the browser lowercases before it connects.
 */
export const WorkspaceId = z.uuidv4().lowercase();

export function isWorkspaceId(value: string): boolean {
  return WorkspaceId.safeParse(value).success;
}

/**
 * Server check for the router hooks (`onBeforeConnect`, `onBeforeRequest`):
 * a 400 for an invalid instance name, nothing when it's valid.
 */
export function rejectInvalidWorkspace(name: string): Response | undefined {
  if (isWorkspaceId(name)) return undefined;
  return new Response(INVALID_WORKSPACE_MESSAGE, { status: 400 });
}

export type WorkspaceRoute =
  | { kind: "open"; id: string; path: string }
  | { kind: "invalid" };

const WORKSPACE_PATH = /^\/w\/([^/]+)\/?$/;

/**
 * Browser routing. `/w/{id}` opens that workspace; `/` reopens the last one
 * from `localStorage`, or starts a new one. Anything else is an invalid link,
 * so a mistyped link never silently opens a different workspace.
 */
export function resolveWorkspace(
  pathname: string,
  lastWorkspace: string | null,
  newId: () => string
): WorkspaceRoute {
  if (pathname === "/") {
    const last = lastWorkspace?.toLowerCase();
    const id = last && isWorkspaceId(last) ? last : newId();
    return { kind: "open", id, path: `/w/${id}` };
  }

  const match = WORKSPACE_PATH.exec(pathname);
  if (!match) return { kind: "invalid" };

  const id = match[1].toLowerCase();
  if (!isWorkspaceId(id)) return { kind: "invalid" };
  return { kind: "open", id, path: `/w/${id}` };
}
