import { describe, expect, it } from "vitest";
import { findSecrets, redactSecrets } from "./secrets";

// Fake keys are assembled at run time, so no complete key appears in the
// source for gitleaks to flag
const KEYS = {
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  github: "ghp_" + "a1".repeat(18),
  slack: "xoxb-" + "1234567890-abcdefghij",
  stripe: "sk_" + "live_" + "Ab1".repeat(8),
  google: "AIza" + "B".repeat(35),
  anthropic: "sk-" + "ant-" + "c".repeat(40),
  privateKey: "-----BEGIN " + "RSA PRIVATE KEY-----"
};

const line = (text: string, n = 7) => ({
  file: "src/config.ts",
  line: n,
  text
});

describe("findSecrets", () => {
  it.each([
    ["an AWS access key ID", KEYS.aws],
    ["a GitHub token", KEYS.github],
    ["a Slack token", KEYS.slack],
    ["a Stripe secret key", KEYS.stripe],
    ["a Google API key", KEYS.google],
    ["an Anthropic or OpenAI API key", KEYS.anthropic],
    ["a private key", KEYS.privateKey]
  ])("reports %s as a no-secrets finding", (kind, key) => {
    expect(findSecrets([line(`const key = "${key}";`)])).toEqual([
      {
        ruleId: "no-secrets",
        file: "src/config.ts",
        line: 7,
        message: `This line appears to contain ${kind}.`,
        suggestion:
          "Remove it, rotate it, and load it from a secret store or an environment variable instead."
      }
    ]);
  });

  it("never puts the key itself in the finding", () => {
    const [finding] = findSecrets([line(`token = "${KEYS.github}"`)]);
    expect(JSON.stringify(finding)).not.toContain(KEYS.github);
  });

  it("reports one finding per line, even with two keys on it", () => {
    expect(findSecrets([line(`${KEYS.aws} ${KEYS.google}`)])).toHaveLength(1);
  });

  it.each([
    ["an environment lookup", "const apiKey = process.env.API_KEY;"],
    ["a short sk- string", 'const mode = "sk-short";'],
    ["a key prefix alone", 'const prefix = "AKIA";']
  ])("ignores %s", (_case, text) => {
    expect(findSecrets([line(text)])).toEqual([]);
  });

  it("gives the same answer every time (no global regex state)", () => {
    const lines = [line(KEYS.aws, 1), line(KEYS.aws, 2), line(KEYS.aws, 3)];
    expect(findSecrets(lines)).toHaveLength(3);
    expect(findSecrets(lines)).toHaveLength(3);
  });
});

describe("redactSecrets", () => {
  it("masks every key and keeps the rest of the text", () => {
    expect(
      redactSecrets(`Remove ${KEYS.aws} and ${KEYS.stripe} from config.ts`)
    ).toBe("Remove [REDACTED] and [REDACTED] from config.ts");
  });

  it("leaves text without keys unchanged", () => {
    expect(redactSecrets("Use the shared HTTP client.")).toBe(
      "Use the shared HTTP client."
    );
  });
});
