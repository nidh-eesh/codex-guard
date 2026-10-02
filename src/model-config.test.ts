import { describe, expect, it } from "vitest";
import { modelDocsUrl } from "./model-config";

describe("modelDocsUrl", () => {
  it("links the Workers AI page named after the last part of the ID", () => {
    expect(modelDocsUrl({ id: "@cf/mistral/mistral-7b-instruct-v0.1" })).toBe(
      "https://developers.cloudflare.com/workers-ai/models/mistral-7b-instruct-v0.1/"
    );
  });
});
