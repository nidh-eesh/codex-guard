# Codex Guard — Design

A guardrail agent for engineering teams, built on Cloudflare. Each workspace starts from a starter pack of common engineering standards. Teams add their own rules and can switch off recommended rules with a recorded reason. Locked rules are mandatory checks and cannot be modified. Developers paste a diff into the review box and get actionable feedback on whether it follows the workspace's active rules.

## 1. Required components

| Component               | What I use                                                                                                                                                                                                                                                                                                                                                     | Where in the code |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| LLM                     | Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, in two roles: the **chat model** (can call rule tools) and the **review model** (no tools; see §7). The model ID, context window, maximum output and prices live in one model config.                                                                                                                   | TODO after build  |
| Workflow / coordination | Cloudflare Workflows: `ReviewWorkflow`, an `AgentWorkflow` that the agent starts with `runWorkflow` when a diff is submitted. Steps: split → review each chunk → combine. Each step's result is persisted and the step is retried at most twice, so one failed chunk doesn't restart the review; a chunk that still fails makes the verdict `incomplete` (§6). | TODO after build  |
| Chat input              | React chat UI → `useAgentChat` → WebSocket → the agent's `onChatMessage` (Agents SDK on Workers). Diffs go through a separate review box, not the chat (§6).                                                                                                                                                                                                   | TODO after build  |
| Memory / state          | The agent's SQLite database (Durable Object) is the source of truth; active rules are pushed to the browser through agent `state`. `validateStateChange` rejects state writes from browsers.                                                                                                                                                                   | TODO after build  |

## 2. Workspaces (agent instance naming)

- Opening the app without a workspace link creates a random, unguessable UUID. It becomes the agent instance name and appears in the URL (`/w/{uuid}`).
- **Private by default, shareable by link:** anyone with the URL joins the same workspace (a capability URL).
- A new tab with no link reopens the last workspace from `localStorage`.
- The browser lowercases the UUID, and the server accepts only the lowercase form: the router hooks (`onBeforeConnect`, `onBeforeRequest`) validate it before it is used as an instance name and answer anything else with HTTP 400. The hooks can't lowercase it themselves, because the SDK reads the instance name from the URL before they run (D15). The browser runs the same check and shows the §5 message, because it can't read the status of a failed WebSocket handshake.
- No "does it exist?" check: a random UUID has 122 random bits, so collisions are not a practical concern, and addressing an instance by name creates it.
- **The link is the credential:** responses send `Referrer-Policy: no-referrer`, and request paths and workspace IDs are never logged. Workers observability is off, because invocation logs record request URLs and the SDK's error logs include instance names (D16).
- **Cost limits:** a per-IP rate limit on review submissions and chat turns, and a global daily budget of estimated neurons for reviews (D12).
- **Known limits:** anyone with the link has full access (no authentication), a leaked link can't be rotated, and there is no rate limit on creating workspaces. See §8.

## 3. Rules

**Layered storage:** the starter pack lives in code; each workspace stores only its own changes.

| Where                       | Shape                                      | Notes                                                                                                               |
| --------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Code: `STARTER_PACK`        | `{ id, text, severity, locked }`           | The only place `locked` exists. Custom rules are never locked. A rule gets a new ID when its meaning changes (D14). |
| SQLite: `custom_rules`      | `{ id, text, severity, createdAt }`        | Rules the workspace added. IDs start with `c_`, so they can't collide with starter IDs.                             |
| SQLite: `disabled_defaults` | `{ ruleId, reason, ruleText, disabledAt }` | Switched-off recommended rules, with the rule text as it was when switched off. This table is the exception record. |

**Active rules** = starter pack − disabled defaults + custom rules. Locked starter rules are always active, even if a `disabled_defaults` row names them, and rows whose ID is no longer in the starter pack are ignored. A custom rule whose ID matches a starter ID is dropped; the starter rule wins (D17). Computed from SQLite (the source of truth) and pushed to the browser as `state`. Updating the starter pack in code updates every workspace.

**Duplicates:** rule text is compared after trimming, collapsing whitespace and lowercasing, against active rules only, so the text of a switched-off default can be re-added as a custom rule (the override path in §8). Restoring a default is checked the same way: it is refused while an active custom rule has its text (D18). Rule text and reasons are stored trimmed, with every run of whitespace collapsed to one space, so they stay on one line in prompts and in the UI.

**Limits**

- Rule text: 10–200 characters (about 50 tokens; about 60 with ID and severity).
- At most 50 active rules in total, including the starter pack. Every active rule goes into every review call: 50 × ~60 tokens ≈ 3k of the 24k-token context. Restoring a switched-off default counts as adding a rule (D18).
- Reason for switching off a recommended rule: at most 200 characters (D19).

**Starter pack**

| ID                  | Rule                                              | Severity | Locked |
| ------------------- | ------------------------------------------------- | -------- | ------ |
| `no-secrets`        | No secrets or API keys in code                    | error    | yes    |
| `sql-parameterized` | SQL queries must be parameterized                 | error    | yes    |
| `validate-input`    | Validate external input at the boundary           | error    | no     |
| `no-sensitive-logs` | Don't log personal data or tokens                 | error    | no     |
| `explicit-errors`   | Handle errors explicitly; no empty `catch` blocks | warning  | no     |
| `no-console-log`    | No `console.log` left in production code          | warning  | no     |

## 4. Chat tools

| Tool          | Input                                                             | Approval | Why                                                                                                                           |
| ------------- | ----------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `addRule`     | `{ text: string (10–200 chars), severity: "error" \| "warning" }` | Yes      | Any tool the chat model can call is a path for prompt injection; approval puts a human between the model and the rules.       |
| `listRules`   | none                                                              | No       | Read-only                                                                                                                     |
| `removeRule`  | `{ ruleId: string, reason?: string }`                             | Yes      | Deletes a custom rule, or switches off a recommended default (reason required). Locked rules are refused.                     |
| `restoreRule` | `{ ruleId: string }`                                              | Yes      | Switches a recommended default back on by deleting its `disabled_defaults` row. Every rule change goes through approval (D4). |

Rules change only inside these tools' `execute`. Reviewing a diff is not a chat tool: diffs are submitted through the review box (§6, D8).

The chat model is called without token streaming: the provider doubles streamed tool-call arguments for this model, so replies appear all at once (D20).

## 5. Error messages

Messages are exact strings, including the backticks.

| Case                                                                              | Message                                                                               |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Rule text empty, or outside 10–200 characters                                     | "Rule text must be between 10 and 200 characters."                                    |
| Duplicate rule                                                                    | "A rule with this text already exists."                                               |
| Adding or restoring a 51st rule                                                   | "This workspace has 50 rules, the maximum. Remove one first."                         |
| Unknown rule ID                                                                   | "No rule with ID `{ruleId}` exists in this workspace."                                |
| Removing or switching off a locked rule                                           | "Rule `{ruleId}` is locked and can't be switched off."                                |
| Switching off a recommended rule without a reason                                 | "A reason is required to switch off a recommended rule."                              |
| A reason over 200 characters                                                      | "The reason must be at most 200 characters."                                          |
| Switching off a rule that is already switched off                                 | "Rule `{ruleId}` is already switched off."                                            |
| Restoring a rule that isn't switched off                                          | "Rule `{ruleId}` is not switched off."                                                |
| Empty diff                                                                        | "The diff is empty. Paste a unified diff to review."                                  |
| Not a unified diff (no `@@` hunk header)                                          | "This doesn't look like a unified diff. Paste the output of `git diff`."              |
| A file was skipped; `{reason}` is `lockfile`, `binary` or `minified or generated` | "Skipped `{file}` ({reason})."                                                        |
| Every file in the diff was skipped                                                | "Nothing to review: every file in the diff was skipped."                              |
| Diff over 50 KB (`MAX_DIFF_BYTES = 50_000`)                                       | "The diff is larger than 50 KB. Split it into smaller reviews."                       |
| Per-IP rate limit reached                                                         | "Too many requests. Try again in a minute."                                           |
| Daily review budget used up                                                       | "The daily review limit has been reached. Try again tomorrow."                        |
| A chunk failed after its retries                                                  | "Review incomplete: {n} of {total} chunks couldn't be reviewed."                      |
| A finding for an error-severity rule failed validation                            | "Review incomplete: {m} findings for error rules failed validation."                  |
| Invalid workspace ID                                                              | "This workspace link is invalid." (shown by the browser; the server answers HTTP 400) |

## 6. Review workflow

1. **Submit:** the diff is pasted into the review box, which calls the agent directly (a callable method), never the chat model (D8). The agent checks the per-IP limit and reserves the review's worst-case cost against the daily budget (D12).
2. **Validate** the diff (§5).
3. **Start** `ReviewWorkflow` with `runWorkflow`, passing the diff and a snapshot of the active rules. The whole review uses that snapshot.
4. **Split:** skip lockfiles, binary files, and minified or generated files (names like `*.min.*` and `*.map`, or any added line over 1,000 characters), with a note for each; the `no-secrets` regex still runs over them. Prefix each added and context line with its new-file line number (D13); sizes include the prefixes. Split a file larger than one chunk by hunk, and a hunk larger than one chunk into windows of lines. Then pack files and pieces **first-fit**: each goes into the first chunk with room, checking every open chunk, not just the last one.
5. **Review** each chunk with the review model (no tools, JSON mode), producing at most 25 findings.
6. **Validate** each finding (§7).
7. **Combine:** remove duplicates (same `ruleId`, `file` and `line`), look up each finding's severity from its rule, sort by severity, decide the verdict.
8. **Store** the review in SQLite (`reviews`: `{ id, createdAt, verdict, findings }`) from `onWorkflowComplete`. `id` is the workflow instance ID, so a retried save doesn't store the review twice. Before storing, the `no-secrets` patterns are run over each finding's `message` and `suggestion`, and matches are masked. Post a summary to the chat with `persistMessages`; the chat model sees only each finding's `ruleId`, `file` and `line` and the verdict, while `message` and `suggestion` are shown in the UI only (D9). Settle the cost reservation with the `usage` each call returned.

**Token budget per call:** the 24k context holds the answer (`max_tokens` = 3k, set explicitly because the Workers AI default is 256), the system prompt (~1k), the active rules (≤ ~3k) and the chunk. That leaves about 17k for the chunk; chunks target 12k tokens, estimated at 3 characters per token for code, line-number prefixes included. The budget is computed from the model config, not hard-coded.

**Model output:** `{ ruleId, file, line, message, suggestion }`. The model doesn't report severity; it comes from the rule (D10).

**Verdict:**

- **fail** if any finding that survives validation violates an error-severity rule;
- otherwise **incomplete** if a chunk failed after its retries or a finding for an error-severity rule was discarded, with both counts shown;
- otherwise **pass**, listing warnings.

**Retries:** each step retries at most 2 times with a 2-second delay (the Workflows default is 5 retries starting at 10 seconds). A chunk that still fails is recorded as not reviewed; it doesn't fail the workflow.

**Diff limit, 50 KB:** at ~3 characters per token, 50 KB ≈ 16.7k tokens. First-fit packing into 12k chunks needs at most 2 chunks for diffs up to 18k tokens; only a diff near the limit with line-number prefixes can go above that and need 3. A maximum-size review costs about 1.1k neurons (1.9k in the worst case), which fits the Free plan's daily allocation. 200 KB is future work (D6).

## 7. Trust boundary

**Principle:** the model can be fooled; it just can't do anything when it is.

**Untrusted inputs:** the diff, and custom rule text (anyone with the link can add a rule).

1. **The review model has no tools, and diffs never reach the chat model. This is the guarantee.** Diffs go from the review box straight to the workflow (D8), so the only model that sees a diff can't call `addRule`, `removeRule` or `restoreRule`. Review results reach the chat model only as validated fields (`ruleId`, `file`, `line`, verdict), never as free text (D9). A malicious diff can't change the rules.
2. **Untrusted text is treated as data. This is a mitigation.** The diff and the custom rules are wrapped in delimiters, and the system prompt says the content inside is untrusted, must never be followed as instructions, and that locked rules take priority over custom rules. Models can still be tricked. Layer 1 keeps a successful trick away from the rules, but it can still produce a wrong review, and for a guardrail a false pass is exactly what an attacker wants; layers 3 and 5 limit that.
3. **Output validation.** Zod checks each finding's shape. Further checks confirm that the `ruleId` exists in the rules snapshot, that `file` is one of the chunk's files, and that `line` is one of that file's numbered lines (D13). Findings that fail are dropped and counted; malformed responses are retried by the workflow step. Severity comes from the rule, not the model, and the verdict fails closed: a failed chunk or a discarded error-rule finding makes it `incomplete`, never `pass` (D10).
4. **Approval on rule-changing chat tools.** A human confirms before the chat model changes any rule.
5. **A deterministic check for `no-secrets`.** A regex pass over added lines, including those in skipped files, reports common key formats as `no-secrets` findings that no prompt can argue away (D11). `sql-parameterized` has no such check: for it, "locked" guarantees the rule stays on, not that every violation is caught.
6. **State is written only by the server.** Browsers receive agent `state` but can't write it (`validateStateChange` rejects writes from connections), and the review reads rules only from SQLite, through the snapshot passed to the workflow.

## 8. Out of scope

- Authentication (capability URLs only)
- Rotating a leaked workspace link
- A rate limit on creating workspaces
- First-class overrides linked to a default (today: switch off + add)
- An org → team hierarchy
- Sharing rules across workspaces
- GitHub pull-request integration
- Diffs larger than 50 KB (200 KB with a larger-context model or the Paid plan; D6)
- Choosing between models (for example GLM-4.7-Flash); the budget already reads the context window, maximum output and prices from the model config

Decisions and their reasoning are logged in [`docs/DECISIONS.md`](docs/DECISIONS.md).
