import { describe, expect, it, vi } from "vitest";
import {
  INVALID_WORKSPACE_MESSAGE,
  isWorkspaceId,
  rejectAgentRoute,
  rejectInvalidWorkspace,
  resolveWorkspace
} from "./workspace";

// Valid v4 UUIDs: version nibble 4, variant nibble 8, 9, a or b
const ID = "3f2a8c1e-5b7d-4e9f-a1c3-0d2e4f6a8b9c";
const OTHER = "9b1d6f0a-2c4e-4a8b-8d0f-1e3c5a7b9d2f";

describe("isWorkspaceId", () => {
  it("accepts a lowercase v4 UUID", () => {
    expect(isWorkspaceId(ID)).toBe(true);
  });

  it("accepts what crypto.randomUUID() produces", () => {
    for (let i = 0; i < 100; i++) {
      expect(isWorkspaceId(crypto.randomUUID())).toBe(true);
    }
  });

  it.each([
    ["uppercase", ID.toUpperCase()],
    ["one uppercase letter", `3F${ID.slice(2)}`],
    ["empty", ""],
    ["nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["max UUID", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ["version 1", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
    ["version 7", "0190f1e2-3a4b-7c5d-8e6f-0a1b2c3d4e5f"],
    ["wrong variant", "3f2a8c1e-5b7d-4e9f-01c3-0d2e4f6a8b9c"],
    ["no hyphens", ID.replaceAll("-", "")],
    ["braces", `{${ID}}`],
    ["URN prefix", `urn:uuid:${ID}`],
    ["leading space", ` ${ID}`],
    ["trailing newline", `${ID}\n`],
    ["one character short", ID.slice(1)],
    ["one character long", `${ID}0`],
    ["non-hex character", `g${ID.slice(1)}`],
    ["percent-encoded character", `%33${ID.slice(1)}`],
    ["fullwidth digit", `３${ID.slice(1)}`],
    ["path traversal", "../../etc/passwd"]
  ])("rejects %s", (_case, value) => {
    expect(isWorkspaceId(value)).toBe(false);
  });
});

describe("rejectAgentRoute", () => {
  it("lets the chat agent through under a workspace ID", () => {
    expect(
      rejectAgentRoute({ className: "ChatAgent", name: ID })
    ).toBeUndefined();
  });

  it.each([
    ["under today's date", "2026-09-28"],
    ["under a valid workspace ID", ID]
  ])(
    "refuses the neuron budget %s: /agents/* can't reach it",
    async (_case, name) => {
      const response = rejectAgentRoute({ className: "NEURON_BUDGET", name });
      expect(response?.status).toBe(404);
    }
  );

  it.each(["REVIEW_WORKFLOW", "AI", "chatagent", ""])(
    "refuses any other binding, like %j",
    (className) => {
      expect(rejectAgentRoute({ className, name: ID })?.status).toBe(404);
    }
  );

  it("still refuses an invalid workspace ID for the chat agent", () => {
    expect(
      rejectAgentRoute({ className: "ChatAgent", name: ID.toUpperCase() })
        ?.status
    ).toBe(400);
  });
});

describe("rejectInvalidWorkspace", () => {
  it("lets a valid ID through", () => {
    expect(rejectInvalidWorkspace(ID)).toBeUndefined();
  });

  it("answers 400 with the invalid-link message", async () => {
    const response = rejectInvalidWorkspace("not-a-workspace");
    expect(response?.status).toBe(400);
    expect(await response?.text()).toBe("This workspace link is invalid.");
  });

  it("rejects the uppercase form instead of opening a second workspace", () => {
    expect(rejectInvalidWorkspace(ID.toUpperCase())?.status).toBe(400);
  });
});

describe("INVALID_WORKSPACE_MESSAGE", () => {
  it("matches DESIGN.md §5 exactly", () => {
    expect(INVALID_WORKSPACE_MESSAGE).toBe("This workspace link is invalid.");
  });
});

describe("resolveWorkspace", () => {
  const newId = () => OTHER;

  describe("at /", () => {
    it("starts a new workspace when none was opened before", () => {
      expect(resolveWorkspace("/", null, newId)).toEqual({
        kind: "open",
        id: OTHER,
        path: `/w/${OTHER}`
      });
    });

    it("reopens the last workspace without creating one", () => {
      const create = vi.fn(newId);
      expect(resolveWorkspace("/", ID, create)).toEqual({
        kind: "open",
        id: ID,
        path: `/w/${ID}`
      });
      expect(create).not.toHaveBeenCalled();
    });

    it("lowercases a stored ID", () => {
      expect(resolveWorkspace("/", ID.toUpperCase(), newId)).toMatchObject({
        id: ID
      });
    });

    it.each([
      ["garbage", "not-a-uuid"],
      ["empty", ""]
    ])("starts a new workspace when the stored ID is %s", (_case, stored) => {
      expect(resolveWorkspace("/", stored, newId)).toMatchObject({
        id: OTHER
      });
    });
  });

  describe("at /w/{id}", () => {
    it("opens the linked workspace, not the stored one", () => {
      expect(resolveWorkspace(`/w/${ID}`, OTHER, newId)).toEqual({
        kind: "open",
        id: ID,
        path: `/w/${ID}`
      });
    });

    it("lowercases the ID and its path", () => {
      expect(resolveWorkspace(`/w/${ID.toUpperCase()}`, null, newId)).toEqual({
        kind: "open",
        id: ID,
        path: `/w/${ID}`
      });
    });

    it("drops a trailing slash from the path", () => {
      expect(resolveWorkspace(`/w/${ID}/`, null, newId)).toMatchObject({
        id: ID,
        path: `/w/${ID}`
      });
    });
  });

  it.each([
    ["no ID", "/w/"],
    ["an empty segment", "/w//"],
    ["an invalid ID", "/w/not-a-uuid"],
    ["an extra segment", `/w/${ID}/extra`],
    ["an encoded space", `/w/${ID}%20`],
    ["an uppercase prefix", `/W/${ID}`],
    ["a double slash", `//w/${ID}`],
    ["another path", "/settings"]
  ])("treats a link with %s as invalid", (_case, pathname) => {
    const create = vi.fn(newId);
    expect(resolveWorkspace(pathname, ID, create)).toEqual({
      kind: "invalid"
    });
    expect(create).not.toHaveBeenCalled();
  });
});
