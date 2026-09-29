# Codex Guard — Design

A guardrail agent for engineering teams, built on Cloudflare. Each workspace starts from a starter pack of common engineering standards. Teams add their own rules and can switch off recommended rules with a recorded reason. Locked rules are mandatory checks and cannot be modified. Developers paste a diff into the review box and get actionable feedback on whether it follows the workspace's active rules.

## 1. Required components

| Component               | What I use                                                                                                                                                                                                                                                                                                                                                     | Where in the code                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LLM                     | Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, in two roles: the **chat model** (can call rule tools) and the **review model** (no tools; see §7). The model ID, context window, maximum output and prices live in one model config.                                                                                                                   | `MODEL` in `src/model-config.ts`. Chat model: `ChatAgent.onChatMessage` in `src/server.ts`, with `ruleTools` from `src/rule-tools.ts`. Review model: `reviewChunk` in `src/review-model.ts` (no tools), prompts in `src/review-prompt.ts`.                                                                                                                               |
| Workflow / coordination | Cloudflare Workflows: `ReviewWorkflow`, an `AgentWorkflow` that the agent starts with `runWorkflow` when a diff is submitted. Steps: split → review each chunk → combine. Each step's result is persisted and the step is retried at most twice, so one failed chunk doesn't restart the review; a chunk that still fails makes the verdict `incomplete` (§6). | `ReviewWorkflow` in `src/review-workflow.ts` runs `runReview` from `src/review-pipeline.ts`: `splitDiff` (`src/diff-split.ts`), `reviewAndValidate` per chunk, `combineReview` (`src/review-combine.ts`). Started by `ChatAgent.submitReview`; results arrive in `onWorkflowComplete` and `onWorkflowError` (`src/server.ts`).                                           |
| Chat input              | React chat UI → `useAgentChat` → WebSocket → the agent's `onChatMessage` (Agents SDK on Workers). Diffs go through a separate review box, not the chat (§6).                                                                                                                                                                                                   | `Chat` in `src/app.tsx` (`useAgentChat`; the review box calls `submitReview`); `src/client.tsx` opens the workspace link. The Worker entry in `src/server.ts` routes `/agents/*` through the route guard to `ChatAgent.onChatMessage`.                                                                                                                                   |
| Memory / state          | The agent's SQLite database (Durable Object) is the source of truth; active rules are pushed to the browser through agent `state`. `validateStateChange` rejects state writes from browsers.                                                                                                                                                                   | `ChatAgent`'s SQLite through `sqliteRuleTables` (`src/rule-tables.ts`) and `sqliteReviews` (`src/review-store.ts`). `readRules` (`src/rule-changes.ts`) resolves the active rules with `resolveRules` (`src/active-rules.ts`). `WorkspaceState` (`src/rule-state.ts`) is pushed by `pushRules` and `pushBudget`; `validateStateChange` calls `rejectBrowserStateWrites`. |

## 2. Workspaces (agent instance naming)

- Opening the app without a workspace link creates a random, unguessable UUID. It becomes the agent instance name and appears in the URL (`/w/{uuid}`).
- **Private by default, shareable by link:** anyone with the URL joins the same workspace (a capability URL).
- A new tab with no link reopens the last workspace from `localStorage`.
- The browser lowercases the UUID, and the server accepts only the lowercase form: the router hooks (`onBeforeConnect`, `onBeforeRequest`) validate it before it is used as an instance name and answer anything else with HTTP 400. The hooks can't lowercase it themselves, because the SDK reads the instance name from the URL before they run (D15). The browser runs the same check and shows the §5 message, because it can't read the status of a failed WebSocket handshake.
- No "does it exist?" check: a random UUID has 122 random bits, so collisions are not a practical concern, and addressing an instance by name creates it.
- **The link is the credential:** responses send `Referrer-Policy: no-referrer`, and request paths and workspace IDs are never logged. Workers observability is off, because invocation logs record request URLs and the SDK's error logs include instance names (D16).
- **Cost limits:** a per-IP rate limit of 3 review submissions and 10 chat turns a minute (IPv6 keyed by its /64; D23), and global daily budgets of 6,000 estimated neurons for reviews (D12) and 3,000 for chat, charged after each turn (D26). A meter on the page shows what's left of both (D27).
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

- Rule text: 10–200 characters. At 3 characters per token (the one estimator, D6), a rule's line in the review prompt is at most 81 tokens with its ID, severity and lock marker.
- At most 50 active rules in total, including the starter pack. Every active rule goes into every review call: 50 × 81 = 4,050 tokens of the 24k-token context. Restoring a switched-off default counts as adding a rule (D18).
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

| Tool          | Input                                                             | Approval                             | Why                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addRule`     | `{ text: string (10–200 chars), severity: "error" \| "warning" }` | Yes, unless refused on its arguments | Any tool the chat model can call is a path for prompt injection; approval puts a human between the model and the rules.                                                     |
| `listRules`   | none                                                              | No                                   | Read-only                                                                                                                                                                   |
| `removeRule`  | `{ ruleIds: string[], reason?: string }`                          | Yes, unless refused on its arguments | Deletes custom rules, or switches off recommended defaults with one reason in the user's own words (D28), all in one call; applies what it can and reports each rule (D29). |
| `restoreRule` | `{ ruleIds: string[] }`                                           | Yes, unless refused on its arguments | Switches recommended defaults back on by deleting their `disabled_defaults` rows, all in one call. Every call that could change a rule goes through approval (D4, D28).     |

A call refused on its arguments alone can't change anything whenever it runs, so it's refused at once without asking: a locked rule, a length limit, an ID no rule could have, or a switch-off reason that's missing, a placeholder, or not in the user's messages the model can see (lowercase, whitespace collapsed, substring match; D28). A call whose outcome depends on the rules in SQLite (already off, not off, a duplicate, the 50-rule cap) waits for approval, because the rules can change before `execute`. A call can name several rules (D29): it waits for approval if any of them could change, applies each that still passes in order, and reports each rule, with the rules as they are after it, so the model needn't call `listRules`. A chat turn ends at 5 steps. After a refused or rejected call, or a batch that refused any rule, the next step runs with no tools and a system note saying why, so the model explains in words and can't retry. The approval card runs the tools' own checks on the rules in agent state, lists each change that will be refused, and disables Approve only when nothing in the call can happen.

Rules change only inside these tools' `execute`. Reviewing a diff is not a chat tool: diffs are submitted through the review box (§6, D8).

The chat model is called without token streaming: the provider doubles streamed tool-call arguments for this model, so replies appear all at once (D20). It sees only the latest 10 messages, and sees the rules only by calling `listRules` (D26).

## 5. Error messages

Messages are exact strings, including the backticks.

| Case                                                                                         | Message                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Rule text empty, or outside 10–200 characters                                                | "Rule text must be between 10 and 200 characters."                                                                                         |
| Duplicate rule                                                                               | "A rule with this text already exists."                                                                                                    |
| Adding or restoring a 51st rule                                                              | "This workspace has 50 rules, the maximum. Remove one first."                                                                              |
| Unknown rule ID                                                                              | "No rule with ID `{ruleId}` exists in this workspace."                                                                                     |
| Removing or switching off a locked rule                                                      | "Rule `{ruleId}` is locked and can't be switched off. Locked rules can't be changed; don't try again."                                     |
| Restoring a locked rule                                                                      | "Rule `{ruleId}` is locked and always on. Locked rules can't be changed; don't try again."                                                 |
| Switching off a recommended rule without a reason                                            | "A reason is required to switch off a recommended rule."                                                                                   |
| A reason under 10 characters, or a placeholder such as "No reason"                           | "The reason must say why the team is switching this rule off, in at least 10 characters."                                                  |
| A reason that isn't in the user's messages the model can see                                 | "The reason must be in the user's own words, and it isn't in their recent messages. Ask the user why the team is switching this rule off." |
| A `removeRule` or `restoreRule` call that names no rule                                      | "Name at least one rule to change."                                                                                                        |
| A call where no rule can change                                                              | Each distinct refusal's message, joined with spaces                                                                                        |
| An approval for changes the server will refuse (Approve is disabled only if none can happen) | "This will be refused:" or "Some of this will be refused:", then each refusal's message                                                    |
| A reason over 200 characters                                                                 | "The reason must be at most 200 characters."                                                                                               |
| Switching off a rule that is already switched off                                            | "Rule `{ruleId}` is already switched off."                                                                                                 |
| Restoring a rule that isn't switched off                                                     | "Rule `{ruleId}` is not switched off."                                                                                                     |
| Empty diff                                                                                   | "The diff is empty. Paste a unified diff to review."                                                                                       |
| Not a unified diff (no `@@` hunk header)                                                     | "This doesn't look like a unified diff. Paste the output of `git diff`."                                                                   |
| A file was skipped; `{reason}` is `lockfile` or `binary`                                     | "Skipped `{file}` ({reason})."                                                                                                             |
| A file was skipped as minified or generated                                                  | "Review incomplete: `{file}` was skipped as minified or generated and could hide code that breaks the rules."                              |
| Every file in the diff was skipped                                                           | "Nothing to review: every file in the diff was skipped."                                                                                   |
| Diff over 50 KB (`MAX_DIFF_BYTES = 50_000`)                                                  | "The diff is larger than 50 KB. Split it into smaller reviews."                                                                            |
| Per-IP rate limit reached                                                                    | "Too many requests. Try again in a minute."                                                                                                |
| A review would fit once the running reviews settle                                           | "Another review is running. Try again in a few minutes."                                                                                   |
| Daily review budget used up                                                                  | "The daily review limit has been reached. Try again tomorrow."                                                                             |
| Daily chat budget used up                                                                    | "The daily chat limit has been reached. Try again tomorrow."                                                                               |
| A chunk failed after its retries                                                             | "Review incomplete: {n} of {total} chunks couldn't be reviewed."                                                                           |
| A finding for an error-severity rule failed validation                                       | "Review incomplete: {m} findings for error rules failed validation."                                                                       |
| A chunk's answer reached the findings cap                                                    | "Too many findings in one part of the diff to be sure no error was missed. Fix these and review again."                                    |
| The review workflow itself failed                                                            | "Review incomplete: the review couldn't be finished. Try again."                                                                           |
| Invalid workspace ID                                                                         | "This workspace link is invalid." (shown by the browser; the server answers HTTP 400)                                                      |

## 6. Review workflow

1. **Submit:** the diff is pasted into the review box, which calls the agent directly (a callable method), never the chat model (D8). The agent checks the per-IP limit (D23) and reserves the review's worst-case cost against the daily budget (D12).
2. **Validate** the diff (§5).
3. **Start** `ReviewWorkflow` with `runWorkflow`, passing the diff and a snapshot of the active rules. The whole review uses that snapshot.
4. **Split:** skip lockfiles, binary files, and minified or generated files (names like `*.min.*` and `*.map`, or any added line over 1,000 characters), with a note for each; a skipped minified or generated file makes the verdict incomplete (D22); the `no-secrets` regex still runs over them. Prefix each added and context line with its new-file line number (D13); sizes include the prefixes. Split a file larger than one chunk by hunk, and a hunk larger than one chunk into windows of lines. Then pack files and pieces **first-fit**: each goes into the first chunk with room, checking every open chunk, not just the last one. If every file is skipped, nothing is sent to the review model, but the `no-secrets` check still runs: the review fails if it finds a key, is incomplete if any file was skipped as minified or generated (D22), and otherwise passes with the "Nothing to review" note.
5. **Review** each chunk with the review model (no tools, JSON mode), asking for at most 25 findings (`maxOutputTokens` / 120). The cap is an instruction, not a limit: every valid finding is kept (D21).
6. **Validate** each finding (§7).
7. **Combine:** remove duplicates (same `ruleId`, `file` and `line`), look up each finding's severity from its rule, sort by severity, decide the verdict.
8. **Store** the review in SQLite (`reviews`: `{ id, createdAt, verdict, findings }`) from `onWorkflowComplete`. `id` is the workflow instance ID, so a retried save doesn't store the review twice. Before storing, the `no-secrets` patterns are run over each finding's `message` and `suggestion`, and matches are masked. Post a summary to the chat with `persistMessages`; the chat model sees only each finding's `ruleId`, `file` and `line` and the verdict, with a `file` that isn't a plain path withheld, while `message` and `suggestion` are shown in the UI only (D9). If the workflow itself fails, the review is stored as `incomplete` with the §5 message, so it never reads as a pass. Settle the cost reservation (D24): each chunk's reported `usage`, plus its failed attempts at their worst case.

**Token budget per call:** the 24k context holds the answer (`max_tokens` = 3k, set explicitly because the Workers AI default is 256), the system prompt (1k reserved), the active rules (4,050 reserved: 50 rules at the longest line) and the chunk. That leaves 15,950 for the chunk; chunks target 12k tokens (half the context window), estimated at 3 characters per token, line-number prefixes included. The same estimator sizes the rules reserve. The 18k two-chunk bound below is 1.5 × the target. The budget is computed from the model config, not hard-coded.

**Model output:** `{ ruleId, file, line, message, suggestion }`. The model doesn't report severity; it comes from the rule (D10).

**Verdict:**

- **fail** if any finding that survives validation violates an error-severity rule;
- otherwise **incomplete** if a chunk failed after its retries, a finding for an error-severity rule was discarded, a chunk's answer reached the findings cap (D21), or a file was skipped as minified or generated (D22), with each count shown;
- otherwise **pass**, listing warnings.

**Retries:** each step retries at most 2 times with a 2-second delay (the Workflows default is 5 retries starting at 10 seconds). A chunk that still fails is recorded as not reviewed; it doesn't fail the workflow.

**Diff limit, 50 KB:** at ~3 characters per token, 50 KB ≈ 16.7k tokens. First-fit packing into 12k chunks needs at most 2 chunks for diffs up to 18k tokens; only a diff near the limit with line-number prefixes can go above that and need 3. A maximum-size review costs about 1.1k neurons, and reserves at most about 3.2k: three full chunks with 50 rules at the longest line (D24). That fits the daily budget. 200 KB is future work (D6).

## 7. Trust boundary

**Principle:** the model can be fooled; it just can't do anything when it is.

**Untrusted inputs:** the diff, and custom rule text (anyone with the link can add a rule).

1. **The review model has no tools, and diffs never reach the chat model. This is the guarantee.** Diffs go from the review box straight to the workflow (D8), so the only model that sees a diff can't call `addRule`, `removeRule` or `restoreRule`. Review results reach the chat model only as validated fields (`ruleId`, `file`, `line`, verdict), never as free text (D9). File paths come from the diff, so a path that isn't plain is withheld. A malicious diff can't change the rules.
2. **Untrusted text is treated as data. This is a mitigation.** The diff and the custom rules are wrapped in delimiters, and the system prompt says the content inside is untrusted, must never be followed as instructions, and that locked rules take priority over custom rules. Models can still be tricked. Layer 1 keeps a successful trick away from the rules, but it can still produce a wrong review, and for a guardrail a false pass is exactly what an attacker wants; layers 3 and 5 limit that.
3. **Output validation.** Zod checks each finding's shape. Further checks confirm that the `ruleId` exists in the rules snapshot, that `file` is one of the chunk's files, and that `line` is one of that file's numbered lines (D13). Findings that fail are dropped and counted; malformed responses are retried by the workflow step. Severity comes from the rule, not the model, and the verdict fails closed: a failed chunk or a discarded error-rule finding makes it `incomplete`, never `pass` (D10).
4. **Approval on rule-changing chat tools.** A human confirms before the chat model changes any rule. A call refused on its arguments alone (a locked rule, a length limit, an ID no rule could have, a missing, placeholder or unquoted reason) is refused at once without asking: it can't change anything, and neither the code nor the call can change before `execute` (D28). A switch-off reason must appear in the user's own messages, so the model can't invent one.
5. **A deterministic check for `no-secrets`.** A regex pass over added lines, including those in skipped files, reports common key formats as `no-secrets` findings that no prompt can argue away (D11). `sql-parameterized` has no such check: for it, "locked" guarantees the rule stays on, not that every violation is caught.
6. **State is written only by the server.** Browsers receive agent `state` but can't write it (`validateStateChange` rejects writes from connections), and the review reads rules only from SQLite, through the snapshot passed to the workflow.
7. **Only the chat agent is routable.** `/agents/*` reaches `ChatAgent` alone; the daily budget is a plain Durable Object reached only by RPC from the agent, and any other class gets a 404 (D25).

**Known limit: raw diffs in Workflows storage.** The diff is passed to `ReviewWorkflow` as an instance parameter, and Workflows keeps instance parameters for the account's retention period; `runWorkflow` can't shorten it. A diff containing a secret is therefore kept there in full: findings are redacted before they are stored (§6 step 8), but the raw input is not.

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
- Supply-chain review of lockfiles and binary files
- A code file named like a lockfile (for example `src/db/yarn.lock`, loaded with `require`) is skipped unreviewed; only the `no-secrets` check scans it.
- A chat message refused by the rate limit or the daily chat limit stays in the history without an answer, and the chat model sees it on the next turn: the SDK saves a message before the agent can refuse it, and removing it would need the SDK's internal APIs.

Decisions and their reasoning are logged in [`docs/DECISIONS.md`](docs/DECISIONS.md).
