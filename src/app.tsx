import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ChatAgent } from "./server";
import type { ResolvedRules } from "./rules";
import type { WorkspaceState } from "./rule-state";
import { ruleChangePreview, ruleIdsOf, rulesToAdd } from "./rule-changes";
import {
  budgetMeterText,
  currentMeter,
  meterTone,
  type BudgetMeter,
  type MeterTone
} from "./budget-meter";
import { REVIEW_PART, type ReviewPartData } from "./review-summary";
import { toolProgress, waitingForModel } from "./chat-status";
import { DIFF_IN_CHAT_MESSAGE, looksLikeDiff } from "./diff-input";
import { INVALID_WORKSPACE_MESSAGE, type WorkspaceRoute } from "./workspace";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  LinkButton,
  Meter,
  PoweredByCloudflare,
  Surface,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BugIcon,
  CircleNotchIcon,
  FileMagnifyingGlassIcon,
  GaugeIcon,
  LinkBreakIcon,
  ListChecksIcon,
  LockIcon,
  WarningCircleIcon,
  ShieldCheckIcon
} from "@phosphor-icons/react";

// ── Small components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Rules ─────────────────────────────────────────────────────────────

function RulesPanel({ rules }: { rules: ResolvedRules }) {
  return (
    <div className="space-y-4">
      <section>
        <Text size="sm" bold>
          Active ({rules.active.length})
        </Text>
        <ul className="mt-2 space-y-2">
          {rules.active.map((rule) => (
            <li
              key={rule.id}
              className="rounded-lg border border-kumo-line p-2.5"
            >
              <div className="flex items-center gap-2">
                <code className="text-xs text-kumo-subtle">{rule.id}</code>
                <Badge variant={rule.severity}>{rule.severity}</Badge>
                {rule.locked && (
                  <LockIcon
                    size={12}
                    className="text-kumo-inactive"
                    aria-label="Locked"
                  />
                )}
              </div>
              <p className="mt-1 text-sm text-kumo-default">{rule.text}</p>
            </li>
          ))}
        </ul>
      </section>
      {rules.switchedOff.length > 0 && (
        <section>
          <Text size="sm" bold>
            Switched off ({rules.switchedOff.length})
          </Text>
          <ul className="mt-2 space-y-2">
            {rules.switchedOff.map((rule) => (
              <li
                key={rule.id}
                className="rounded-lg border border-kumo-line p-2.5"
              >
                <code className="text-xs text-kumo-subtle">{rule.id}</code>
                <p className="mt-1 text-sm text-kumo-subtle line-through">
                  {rule.text}
                </p>
                <p className="mt-1 text-xs text-kumo-default">
                  Reason: {rule.reason}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * What an approval would do, in words. Rule text comes from the server's
 * state, not from the model's tool input, so the person approving sees the
 * rule the ID really points at.
 */
function describeRuleChange(
  toolName: string,
  input: unknown,
  rules: ResolvedRules | null
): string[] {
  const args = (input ?? {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const known = (id: string) =>
    rules?.active.find((r) => r.id === id) ??
    rules?.switchedOff.find((r) => r.id === id);
  switch (toolName) {
    case "addRule":
      return rulesToAdd(input).map(
        (rule) => `Add a ${rule.severity} rule: "${rule.text}"`
      );
    case "removeRule": {
      const lines = ruleIdsOf(input).map((id) => {
        const rule = known(id);
        if (!rule) return `\`${id}\``;
        return "source" in rule && rule.source === "custom"
          ? `Delete the custom rule "${rule.text}"`
          : `Switch off "${rule.text}"`;
      });
      return args.reason ? [...lines, `Reason: "${str(args.reason)}"`] : lines;
    }
    case "restoreRule":
      return ruleIdsOf(input).map((id) => {
        const rule = known(id);
        return rule ? `Switch "${rule.text}" back on` : `\`${id}\``;
      });
    default:
      return [];
  }
}

// ── Reviews ───────────────────────────────────────────────────────────

const VERDICT = {
  pass: { label: "Passed", badge: "success" },
  fail: { label: "Failed", badge: "error" },
  incomplete: { label: "Incomplete", badge: "warning" }
} as const;

/**
 * A finished review. A finding's message and suggestion are model text
 * shaped by the diff, so they're plain React text: never markdown, never HTML.
 */
function ReviewCard({ review }: { review: ReviewPartData }) {
  const verdict = VERDICT[review.verdict];
  const count = review.findings.length;
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[85%] space-y-3 rounded-xl bg-kumo-base px-4 py-3 ring ring-kumo-line">
        <div className="flex items-center gap-2">
          <FileMagnifyingGlassIcon size={16} className="text-kumo-inactive" />
          <Text size="sm" bold>
            Review
          </Text>
          <Badge variant={verdict.badge}>{verdict.label}</Badge>
          <Text size="xs" variant="secondary">
            {count === 1 ? "1 finding" : `${count} findings`}
          </Text>
        </div>
        {review.notes.length > 0 && (
          <ul className="space-y-1">
            {review.notes.map((note, i) => (
              <li key={i} className="text-sm text-kumo-default">
                {note}
              </li>
            ))}
          </ul>
        )}
        {count > 0 && (
          <ul className="space-y-2">
            {review.findings.map((finding, i) => (
              <li key={i} className="rounded-lg border border-kumo-line p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={finding.severity}>{finding.severity}</Badge>
                  <code className="text-xs text-kumo-subtle">
                    {finding.ruleId}
                  </code>
                  <code className="break-all text-xs text-kumo-default">
                    {finding.file}:{finding.line}
                  </code>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-kumo-default">
                  {finding.message}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-kumo-subtle">
                  Suggestion: {finding.suggestion}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Tool rendering ────────────────────────────────────────────────────

function ToolIO({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <div className="mt-1">
      <Text size="xs" variant="secondary" bold>
        {label}
      </Text>
      <pre className="mt-0.5 font-mono text-xs text-kumo-subtle whitespace-pre-wrap overflow-auto max-h-64">
        {text}
      </pre>
    </div>
  );
}

function ToolPartView({
  part,
  rules,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  rules: ResolvedRules | null;
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const progress = toolProgress(part);

  // Completed
  if (progress === "done") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <ToolIO label="Input" value={part.input} />
          <ToolIO label="Output" value={part.output} />
        </Surface>
      </div>
    );
  }

  // Needs approval
  if (progress === "awaiting-approval" && "approval" in part) {
    const approvalId = (part.approval as { id?: string })?.id;
    const description = describeRuleChange(toolName, part.input, rules);
    // The server's own checks, run on the rules this page has: a call where
    // nothing can happen can't be approved (D28). The server checks again.
    // Until the rules arrive nothing can be checked, so nothing is approved.
    const preview = rules
      ? ruleChangePreview(toolName, part.input, rules)
      : { refusals: [], allRefused: false };
    const canApprove = rules !== null && !preview.allRefused;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <GearIcon size={14} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approval needed: {toolName}
            </Text>
          </div>
          {description.length > 0 && (
            <ul className="mb-2 space-y-0.5 text-sm text-kumo-default">
              {description.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {preview.refusals.length > 0 && (
            <div role="alert" className="mb-2 text-sm text-kumo-danger">
              <p className="flex items-center gap-1.5">
                <WarningCircleIcon size={16} className="shrink-0" />
                {preview.allRefused
                  ? "This will be refused:"
                  : "Some of this will be refused:"}
              </p>
              <ul className="ml-6 list-disc">
                {preview.refusals.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="font-mono mb-3">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          {rules === null && (
            <p className="mb-2 flex items-center gap-1.5 text-xs text-kumo-subtle">
              <CircleNotchIcon size={12} className="animate-spin" />
              Loading the workspace's rules to check this change...
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              disabled={!canApprove}
              onClick={() => {
                if (approvalId && canApprove) {
                  addToolApprovalResponse({ id: approvalId, approved: true });
                }
              }}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: false });
                }
              }}
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  // Approved, and waiting for the server to apply it
  if (progress === "applying") {
    const description = describeRuleChange(toolName, part.input, rules);
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <CircleNotchIcon
              size={14}
              className="text-kumo-inactive animate-spin"
            />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Approved</Badge>
            <Text size="xs" variant="secondary">
              Applying...
            </Text>
          </div>
          {description.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-sm text-kumo-default">
              {description.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Surface>
      </div>
    );
  }

  // Rejected / denied
  if (progress === "rejected") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </Surface>
      </div>
    );
  }

  // Errored
  if (progress === "failed" && part.state === "output-error") {
    const errorText = part.errorText;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring-2 ring-kumo-danger">
          <div className="flex items-center gap-2 mb-1">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="destructive">Error</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {errorText || "Tool call failed"}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  // The model is still writing the call, or the server is running it. A
  // call's input is shown only once it's whole
  return (
    <div className="flex justify-start">
      <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
        <div className="flex items-center gap-2">
          <GearIcon size={14} className="text-kumo-inactive animate-spin" />
          <Text size="xs" variant="secondary">
            {progress === "preparing"
              ? `Preparing ${toolName}...`
              : `Running ${toolName}...`}
          </Text>
        </div>
        {progress === "running" && <ToolIO label="Input" value={part.input} />}
      </Surface>
    </div>
  );
}

// ── Main chat ─────────────────────────────────────────────────────────

// Bar colours by tone; "ok" keeps the Meter's brand colour
const TONE_INDICATOR: Record<MeterTone, string> = {
  ok: "",
  low: "from-kumo-warning via-kumo-warning to-kumo-warning",
  empty: ""
};
const TONE_TRACK: Record<MeterTone, string> = {
  ok: "",
  low: "",
  empty: "bg-kumo-danger-tint"
};

function BudgetGauge({ label, percent }: { label: string; percent: number }) {
  const tone = meterTone(percent);
  return (
    <Meter
      label={label}
      value={percent}
      customValue={`${percent}% left`}
      indicatorClassName={TONE_INDICATOR[tone]}
      trackClassName={TONE_TRACK[tone]}
    />
  );
}

/**
 * The shared budget meter, pushed by the server as agent state (D27). It
 * sits above the review box and the chat input: the two things it pays for.
 */
function BudgetMeterCard({ meter }: { meter: BudgetMeter | null }) {
  const current = currentMeter(meter, new Date());
  if (!current) return null;
  return (
    <section
      aria-label="Shared AI budget today"
      title={budgetMeterText(current)}
      className="mb-3 rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-2.5"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-kumo-default">
          <GaugeIcon size={14} />
          Shared AI budget today
        </span>
        <span className="text-xs text-kumo-subtle">
          Resets 05:30 IST (00:00 UTC)
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6">
        <BudgetGauge label="Reviews" percent={current.reviews} />
        <BudgetGauge label="Chat" percent={current.chat} />
      </div>
    </section>
  );
}

// The socket reconnects by itself after a drop
type Connection = "connecting" | "connected" | "reconnecting";

const CONNECTION = {
  connecting: { label: "Connecting...", tone: "text-kumo-warning" },
  connected: { label: "Connected", tone: "text-kumo-success" },
  reconnecting: { label: "Reconnecting...", tone: "text-kumo-danger" }
} as const;

/** The model is working, with nothing of it on screen yet. */
function ThinkingBubble() {
  return (
    <output className="flex justify-start">
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-kumo-base px-4 py-2.5 text-sm text-kumo-subtle">
        <CircleNotchIcon size={14} className="animate-spin" />
        Thinking...
      </div>
    </output>
  );
}

/** Where a review's result will appear, while its workflow runs. */
function ReviewPendingCard() {
  return (
    <output className="flex justify-start">
      <div className="flex w-full max-w-[85%] items-center gap-2 rounded-xl bg-kumo-base px-4 py-3 ring ring-kumo-line">
        <CircleNotchIcon
          size={16}
          className="animate-spin text-kumo-inactive"
        />
        <Text size="sm" bold>
          Reviewing the diff...
        </Text>
        <Text size="xs" variant="secondary">
          The result will appear here.
        </Text>
      </div>
    </output>
  );
}

function Chat({ workspaceId }: { workspaceId: string }) {
  const [connection, setConnection] = useState<Connection>("connecting");
  const connected = connection === "connected";
  const [input, setInput] = useState("");
  // Shown under the chat input; cleared when the input changes
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  // Pushed by the server as agent state; the browser never writes it
  const [rules, setRules] = useState<ResolvedRules | null>(null);
  const [budget, setBudget] = useState<BudgetMeter | null>(null);
  const [showRules, setShowRules] = useState(false);
  const rulesPanelRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<ChatAgent, WorkspaceState>({
    agent: "ChatAgent",
    name: workspaceId,
    onOpen: useCallback(() => setConnection("connected"), []),
    onClose: useCallback(() => setConnection("reconnecting"), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback((state: WorkspaceState) => {
      setRules(state);
      setBudget(state.budget ?? null);
    }, [])
  });

  // Close the rules panel when clicking outside it
  useEffect(() => {
    if (!showRules) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        rulesPanelRef.current &&
        !rulesPanelRef.current.contains(e.target as Node)
      ) {
        setShowRules(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showRules]);

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status,
    // A turn the server refused, e.g. over the per-IP limit (DESIGN.md §5)
    error: chatError
  } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Re-focus the input after streaming ends
  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    // A diff never goes to the chat model; the server refuses one too (D35)
    if (looksLikeDiff(text)) {
      setChatNotice(DIFF_IN_CHAT_MESSAGE);
      return;
    }
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendMessage]);

  // The review box calls the agent directly; the diff never enters the chat (D8)
  const [reviewOpen, setReviewOpen] = useState(true);
  const reviewBoxRef = useRef<HTMLTextAreaElement>(null);
  const [diff, setDiff] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingReviewId, setPendingReviewId] = useState<string | null>(null);
  // A review is done once its message arrives in the chat
  const reviewing =
    pendingReviewId !== null &&
    !messages.some((m) => m.id === `review-${pendingReviewId}`);

  const submitReview = useCallback(async () => {
    setReviewError(null);
    setSubmitting(true);
    try {
      const { reviewId } = await agent.stub.submitReview(diff);
      setPendingReviewId(reviewId);
      setDiff("");
    } catch (e) {
      // The server's DESIGN.md §5 message, e.g. for a diff over 50 KB
      setReviewError(
        e instanceof Error ? e.message : "The review couldn't be started."
      );
    } finally {
      setSubmitting(false);
    }
  }, [agent, diff]);

  // A diff typed into the chat moves to the review box in one click, unless
  // the box already holds something it would replace
  const canMoveToReview = chatNotice !== null && !diff.trim();
  const moveToReview = useCallback(() => {
    setDiff(input.trim());
    setInput("");
    setChatNotice(null);
    setReviewOpen(true);
    requestAnimationFrame(() => reviewBoxRef.current?.focus());
  }, [input]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      {/* On phones: labels go screen-reader-only, the debug switch is
          hidden, and the rules panel spans the header */}
      <header className="relative px-3 py-4 sm:px-5 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="flex items-center gap-1.5 whitespace-nowrap text-base font-semibold text-kumo-default sm:gap-2 sm:text-lg">
              <ShieldCheckIcon size={20} weight="bold" />
              Codex Guard
            </h1>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={CONNECTION[connection].tone}
              />
              <span className="sr-only sm:not-sr-only">
                <Text size="xs" variant="secondary">
                  {CONNECTION[connection].label}
                </Text>
              </span>
            </div>
            <div className="hidden items-center gap-1.5 sm:flex">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <div className="sm:relative" ref={rulesPanelRef}>
              <Button
                variant="secondary"
                icon={<ListChecksIcon size={16} />}
                onClick={() => setShowRules(!showRules)}
                disabled={!rules}
              >
                <span className="sr-only sm:not-sr-only">Rules</span>
                {rules && (
                  <Badge variant="secondary" className="sm:ml-1.5">
                    {rules.active.length}
                  </Badge>
                )}
              </Button>
              {showRules && rules && (
                <div className="absolute inset-x-3 top-full mt-2 z-50 max-h-[70vh] overflow-y-auto rounded-xl bg-kumo-base ring ring-kumo-line shadow-lg p-4 sm:inset-x-auto sm:right-0 sm:w-96">
                  <RulesPanel rules={rules} />
                </div>
              )}
            </div>
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              <span className="sr-only sm:not-sr-only">Clear</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Ask about this workspace's rules, or review a diff below"
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;
            // A review message's text part is the chat model's summary; the
            // card shows the full review from the data part instead
            const review = message.parts.find(
              (part) => part.type === REVIEW_PART
            ) as { data: ReviewPartData } | undefined;

            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}

                {review && <ReviewCard review={review.data} />}

                {/* Render parts in chronological (array) order */}
                {!review &&
                  message.parts.map((part, i) => {
                    const key = `${message.id}-${i}`;

                    if (isToolUIPart(part)) {
                      return (
                        <ToolPartView
                          key={key}
                          part={part}
                          rules={rules}
                          addToolApprovalResponse={addToolApprovalResponse}
                        />
                      );
                    }

                    if (part.type === "text") {
                      if (!part.text) return null;

                      if (isUser) {
                        return (
                          <div key={key} className="flex justify-end">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                              {part.text}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={key} className="flex justify-start">
                          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                            <Streamdown
                              className="sd-theme rounded-2xl rounded-bl-md p-3"
                              plugins={{ code }}
                              controls={false}
                              isAnimating={isLastAssistant && isStreaming}
                            >
                              {part.text}
                            </Streamdown>
                          </div>
                        </div>
                      );
                    }

                    return null;
                  })}
              </div>
            );
          })}

          {waitingForModel(status, messages) && <ThinkingBubble />}
          {reviewing && <ReviewPendingCard />}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <div className="max-w-3xl mx-auto px-5 pt-4">
          <BudgetMeterCard meter={budget} />
          <details
            open={reviewOpen}
            onToggle={(e) => setReviewOpen(e.currentTarget.open)}
            className="rounded-xl border border-kumo-line"
          >
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm font-medium text-kumo-default">
              <FileMagnifyingGlassIcon size={16} />
              Review a diff
              {reviewing && (
                <span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-kumo-subtle">
                  <CircleNotchIcon size={12} className="animate-spin" />
                  Reviewing...
                </span>
              )}
            </summary>
            <div className="space-y-2 px-3 pb-3">
              <textarea
                ref={reviewBoxRef}
                value={diff}
                onChange={(e) => setDiff(e.target.value)}
                rows={5}
                spellCheck={false}
                aria-label="Diff to review"
                placeholder="Paste the output of git diff"
                className="w-full rounded-lg border border-kumo-line bg-kumo-base p-2 font-mono text-xs text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-ring"
              />
              {reviewError && (
                <p role="alert" className="text-sm text-kumo-danger">
                  {reviewError}
                </p>
              )}
              <Button
                variant="primary"
                size="sm"
                icon={
                  submitting ? (
                    <CircleNotchIcon size={14} className="animate-spin" />
                  ) : (
                    <FileMagnifyingGlassIcon size={14} />
                  )
                }
                onClick={submitReview}
                disabled={!connected || submitting || reviewing || !diff.trim()}
              >
                {submitting
                  ? "Starting..."
                  : reviewing
                    ? "Reviewing..."
                    : "Review"}
              </Button>
            </div>
          </details>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          {chatError && !chatNotice && (
            <p role="alert" className="mb-2 text-sm text-kumo-danger">
              {chatError.message}
            </p>
          )}
          {chatNotice && (
            <div
              role="alert"
              className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-kumo-danger"
            >
              <span className="flex items-center gap-1.5">
                <WarningCircleIcon size={16} className="shrink-0" />
                {chatNotice}
              </span>
              {canMoveToReview && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  icon={<FileMagnifyingGlassIcon size={14} />}
                  onClick={moveToReview}
                >
                  Move it to the review box
                </Button>
              )}
            </div>
          )}
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={(value) => {
                setInput(value);
                setChatNotice(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder="Send a message..."
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

// The browser can't read the status of a failed WebSocket handshake, so it
// checks the link itself and never connects with an invalid ID.
function InvalidLink() {
  return (
    <div className="flex items-center justify-center h-screen bg-kumo-elevated">
      <Empty
        icon={<LinkBreakIcon size={32} />}
        title={INVALID_WORKSPACE_MESSAGE}
        contents={<LinkButton href="/">Open a workspace</LinkButton>}
      />
    </div>
  );
}

export default function App({ workspace }: { workspace: WorkspaceRoute }) {
  if (workspace.kind === "invalid") return <InvalidLink />;
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat workspaceId={workspace.id} />
      </Suspense>
    </Toasty>
  );
}
