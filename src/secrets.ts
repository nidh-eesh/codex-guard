import type { AddedLine, ModelFinding } from "./review-types";

/**
 * Common key formats. The deterministic side of the locked `no-secrets` rule
 * (D11): no prompt can argue these findings away.
 */
export const SECRET_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "an AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: "a GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g
  },
  { kind: "a Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: "a Stripe secret key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g
  },
  { kind: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    kind: "an Anthropic or OpenAI API key",
    pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/g
  },
  {
    kind: "a private key",
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g
  }
];

const SUGGESTION =
  "Remove it, rotate it, and load it from a secret store or an environment variable instead.";

/**
 * One `no-secrets` finding per added line that matches a key format. The
 * finding names the kind of key, never the key itself.
 */
export function findSecrets(lines: readonly AddedLine[]): ModelFinding[] {
  const findings: ModelFinding[] = [];
  for (const { file, line, text } of lines) {
    const match = SECRET_PATTERNS.find(({ pattern }) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
    if (match) {
      findings.push({
        ruleId: "no-secrets",
        file,
        line,
        message: `This line appears to contain ${match.kind}.`,
        suggestion: SUGGESTION
      });
    }
  }
  return findings;
}

/** Masks every key-format match, for text that is stored or shown. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, { pattern }) => redacted.replace(pattern, "[REDACTED]"),
    text
  );
}
