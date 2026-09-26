# Codex Guard — Design

A guardrail agent for engineering teams, built on Cloudflare. Each workspace starts from a starter pack of common engineering standards. Teams add their own rules and can switch off recommended rules with a recorded reason. Locked rules are mandatory checks and cannot be modified. Developers paste a diff and get actionable feedback on whether it follows the workspace's active rules.

## 1. Required components

| Component | What I use | Where in the code |
|---|---|---|
| LLM | Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, in two roles: the **chat model** (can call rule tools) and the **review model** (no tools; see §7) | TODO after build |
| Workflow / coordination | Cloudflare Workflows: `ReviewWorkflow`, started by the agent when a diff arrives. Steps: split → review each chunk → combine. Each step is retried and its result persisted, so one failed chunk doesn't restart the review. | TODO after build |
| Chat input | React chat UI → `useAgentChat` → WebSocket → the agent's `onChatMessage` (Agents SDK on Workers) | TODO after build |
| Memory / state | The agent's SQLite database (Durable Object) is the source of truth; active rules are pushed to the browser through agent `state` | TODO after build |

## 2. Workspaces (agent instance naming)

- Opening the app without a workspace link creates a random, unguessable UUID. It becomes the agent instance name and appears in the URL (`/w/{uuid}`).
- **Private by default, shareable by link:** anyone with the URL joins the same workspace (a capability URL).
- A new tab with no link reopens the last workspace from `localStorage`.
- The server validates the UUID format before using it as an instance name.
- No "does it exist?" check: a random UUID has 122 random bits, so collisions are not a practical concern, and addressing an instance by name creates it.
- **Known limits:** anyone with the link has full access (no authentication), and there is no rate limit on creating workspaces. See §8.

## 3. Rules

**Layered storage:** the starter pack lives in code; each workspace stores only its own changes.

| Where | Shape | Notes |
|---|---|---|
| Code: `STARTER_PACK` | `{ id, text, severity, locked }` | The only place `locked` exists. Custom rules are never locked. |
| SQLite: `custom_rules` | `{ id, text, severity, createdAt }` | Rules the workspace added |
| SQLite: `disabled_defaults` | `{ ruleId, reason, disabledAt }` | Switched-off recommended rules. This table is the exception record. |

**Active rules** = starter pack − disabled defaults + custom rules. Computed from SQLite (the source of truth) and pushed to the browser as `state`. Updating the starter pack in code updates every workspace.

**Limits**
- Rule text: 10–200 characters (about 40 tokens).
- At most 50 active rules in total, including the starter pack. Every active rule goes into every review call: 50 × ~40 tokens ≈ 2k of the 24k-token context.

**Starter pack**

| ID | Rule | Severity | Locked |
|---|---|---|---|
| `no-secrets` | No secrets or API keys in code | error | yes |
| `sql-parameterized` | SQL queries must be parameterized | error | yes |
| `validate-input` | Validate external input at the boundary | error | no |
| `no-sensitive-logs` | Don't log personal data or tokens | error | no |
| `explicit-errors` | Handle errors explicitly; no empty `catch` blocks | warning | no |
| `no-console-log` | No `console.log` left in production code | warning | no |

## 4. Chat tools

| Tool | Input | Approval | Why |
|---|---|---|---|
| `addRule` | `{ text: string (10–200 chars), severity: "error" \| "warning" }` | Yes | Any tool the chat model can call is a path for prompt injection; approval puts a human between the model and the rules. |
| `listRules` | none | No | Read-only |
| `removeRule` | `{ ruleId: string, reason?: string }` | Yes | Deletes a custom rule, or switches off a recommended default (reason required). Locked rules are refused. |
| `reviewDiff` | `{ diff: string (≤ 200 KB) }` | No | User-initiated and doesn't change rules; starts `ReviewWorkflow`. |

## 5. Invalid input

| Case | Message |
|---|---|
| Rule text empty, or outside 10–200 characters | "Rule text must be between 10 and 200 characters." |
| Duplicate rule | "A rule with this text already exists." |
| Adding a 51st rule | "This workspace has 50 rules, the maximum. Remove one first." |
| Unknown rule ID | "No rule with ID `{ruleId}` exists in this workspace." |
| Removing or switching off a locked rule | "Rule `{ruleId}` is locked and can't be switched off." |
| Switching off a recommended rule without a reason | "A reason is required to switch off a recommended rule." |
| Empty diff | "The diff is empty. Paste a unified diff to review." |
| Diff over 200 KB | "The diff is larger than 200 KB. Split it into smaller reviews." |
| Invalid workspace ID | "This workspace link is invalid." (HTTP 400) |

## 6. Review workflow

1. **Validate** the diff (§5).
2. **Split** by file, then by change hunk for large files, so every chunk fits the token budget.
3. **Review** each chunk with the review model (no tools), producing findings.
4. **Validate** each finding (§7).
5. **Combine:** remove duplicates, sort by severity, decide the verdict.
6. **Store** the review in SQLite (`reviews`: `{ id, createdAt, verdict, findings }`) and post a summary to the chat.

**Token budget per call:** system prompt + active rules (≤ ~2k) + chunk + room for the answer must fit in 24k tokens. That sets the chunk size.

**Finding shape:** `{ ruleId, file, line, severity, message, suggestion }`

**Verdict:** fail if any locked or error-severity rule is violated; otherwise pass, listing warnings.

**Diff limit, 200 KB:** TODO — one-line reason (≈ 4 characters per token → 200 KB ≈ 50k tokens → how many chunks?).

## 7. Trust boundary

**Principle:** the model can be fooled; it just can't do anything when it is.

1. **The review model has no tools. This is the guarantee.** It can't call `addRule` or `removeRule`, so a malicious diff can't change the rules. The worst case is a wrong review.
2. **The diff is treated as data. This is a mitigation.** It's wrapped in delimiters, and the system prompt says the content inside is untrusted and must never be followed as instructions. Models can still be tricked; layer 1 makes a successful trick harmless.
3. **Output validation.** Zod checks each finding's shape. Two further checks confirm that the `ruleId` exists in the active rules and that the `line` falls inside the chunk, which catches invented findings. Findings that fail are dropped; malformed responses are retried by the workflow step.
4. **Approval on rule-changing chat tools.** A human confirms before the chat model changes any rule.

## 8. Out of scope

- Authentication (capability URLs only)
- A rate limit on creating workspaces
- First-class overrides linked to a default (today: switch off + add)
- An org → team hierarchy
- Sharing rules across workspaces
- GitHub pull-request integration

Decisions and their reasoning are logged in [`docs/DECISIONS.md`](docs/DECISIONS.md).
