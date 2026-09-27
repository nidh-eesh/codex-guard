import type { UIMessage } from "ai";
import { redactSecrets } from "./secrets";
import type { ReviewResult } from "./review-types";

/** The message part that carries the full review, for the UI only (D9). */
export const REVIEW_PART = "data-review";

export interface ReviewPartData extends ReviewResult {
  reviewId: string;
}

// File paths come from the diff, which an attacker writes. Only plain paths
// reach the chat model; anything else is withheld.
const PLAIN_PATH = /^[A-Za-z0-9._/@+-]{1,200}$/;

const VERDICT_TEXT = {
  pass: "passed",
  fail: "failed",
  incomplete: "is incomplete"
} as const;

/**
 * What the chat model reads about a review: the verdict, and each finding's
 * rule, file and line. Never `message` or `suggestion` (D9).
 */
export function reviewSummaryText(result: ReviewResult): string {
  const lines = result.findings.map(
    ({ ruleId, file, line }) =>
      `- ${ruleId} at ${PLAIN_PATH.test(file) ? file : "(file name withheld)"}:${line}`
  );
  return [
    `Review ${VERDICT_TEXT[result.verdict]}.`,
    ...(lines.length > 0 ? ["Findings:", ...lines] : ["No findings."])
  ].join("\n");
}

/** The chat message posted for a finished review. */
export function reviewMessage(
  reviewId: string,
  result: ReviewResult
): UIMessage {
  const data: ReviewPartData = { reviewId, ...result };
  return {
    id: `review-${reviewId}`,
    role: "assistant",
    parts: [
      { type: "text", text: reviewSummaryText(result) },
      { type: REVIEW_PART, data }
    ]
  };
}

/**
 * Removes the full review from messages bound for the chat model. The SDK
 * already skips data parts; this doesn't rely on that.
 */
export function stripReviewDetails(
  messages: readonly UIMessage[]
): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => part.type !== REVIEW_PART)
  }));
}

/** Masks key-format matches in each finding's free text before it's stored or shown. */
export function redactReview(result: ReviewResult): ReviewResult {
  return {
    ...result,
    findings: result.findings.map((finding) => ({
      ...finding,
      message: redactSecrets(finding.message),
      suggestion: redactSecrets(finding.suggestion)
    }))
  };
}
