# Prompt history

AI-assisted coding was used on this project, as the assignment allows. This file is the prompt history.

- **Build:** Claude Code in this repo. Every prompt is appended below automatically, verbatim, by a `UserPromptSubmit` hook (`.claude/hooks/log-prompt.sh`).
- **Notes:** after some entries I add a `> Note:` line recording what I accepted, rejected, or corrected, and why.

## Build log


### 2026-09-26 09:15 UTC

````text


<pasted_content id="d095">
Review DESIGN.md and docs/DECISIONS.md as a senior engineer on a developer-productivity team would review a design before implementation. Do not rewrite or edit either file; report findings only.

Check for:
1. Internal contradictions between sections, and between DESIGN.md and DECISIONS.md.
2. Claims that don't match how the Agents SDK, Durable Objects, Workflows, or Workers AI actually behave.
3. Security gaps, especially in the trust boundary and workspace access.
4. Token-budget and size-limit arithmetic: check the numbers.
5. Invariants in AGENTS.md that can't be tested as written.
6. Scope risk: this has to be built quick as it is a demo submission.
7. Questions an interviewer would ask that the docs don't answer.

For each finding give: section, the problem, why it matters, and a suggested fix in one line. Rank by severity. Say explicitly if you find nothing serious in a category, and don't pad the list.
</pasted_content id="d095">
````

### 2026-09-26 10:42 UTC

````text
Accept 1, 2, 3, 4, 5, 
6: "A global daily cap on reviews, plus per-IP rate limiting. Stay on the free plan, with the 50 KB limit and a cap, it's enough for a demo. Consider the chance that a better model like GLM 4.7 flash will be added as an option to choose between models in future", 
7: "Use 3 chars/token for code, pack small files into chunks, skip lockfiles, and drop the limit to 50 KB for the demo (1-3 chunks, fits the free plan). Record 200 KB as future work. Correct the numbers in D5 and D6.", 
accept 8, 9, 10, 11, 12: "Send Referrer-Policy: no-referrer, never log paths or workspace IDs, but link rotation is out of scope", 13: "Tests that locked rules are always active", 
accept 14-20
````

### 2026-09-26 11:13 UTC

````text
1. Use a neuron estimated budget
2. Both
3. Needs Approval
4. Proceed with that change
5. Proceed with MAX_DIFF_BYTES = 50_000

Add D14.
````

### 2026-09-26 14:42 UTC

````text
Incorporate the proposed edits and add first-fit chunk packaging as norm
````

### 2026-09-26 14:59 UTC

````text
Start the build. Read @DESIGN.md and @docs/DECISIONS.md first, @AGENTS.md has the rules for working on this repo. Nothing has been coded yet. Only the docs and starter template created with npm create cloudflare@latest -- starter-tmp --template cloudflare/agents-starter. 

Build in this order, stop after each step so that I can review, test and commit.
1. Cleanup: remove the example tools and the starter banner, add the model config module, switch to llama-3.3-70b-instruct-fp8-fast, add gitleaks to CI.
2. Workspaces: /w/{uuid} routing, UUID check in onBeforeConnect and onBeforeRequest , reopening the last workspace from localstorage, the Referrer-Policy header, the invalid-link message.
3. Rules: STARTER_PACK, the SQLite database, the four tools with approval, and state the state should be pushed to the browser, also validateStateChange
4. Review: the review box, the callable method, diff validation, ReviewWorkflow with retries, storing reviews, the chat summary with only the validated fields.
5. Cost controls: per-Ip rate limits and the daily limit in neuron budget
6. README with setup and deploy steps, then deploy

The three author-owned modules in AGENTS.md are mine. When you get to one, write the types, the function signature with a TODO body, and the Vitest cases you think it needs, then stop. Don't implement them. Once I've written them, build on top. Don't rely on memory for the SDK. Check the installed versions in node_modules before using runWorkflow, persistMessages, needsApproval or validateStateChange. If DESIGN.md asks for something the SDK doesn't support, stop and tell me instead of working around it.Ask before adding any dependency the starter doesn't already have. Don't commit. I'll do that.
````

### 2026-09-26 17:32 UTC

````text


<pasted_content id="2b91">
Before step 2, a few fixes.

1. Pin every action in .github/workflows to a full commit SHA with a version comment, and add Dependabot for github-actions. In sanity-check.yml pin the Node version, use npm ci, and add permissions: contents: read.
2. Remove /oauth/* from run_worker_first.
3. Add to the AGENTS.md invariants: never pass options.clientTools to the model.
4. Add vitest as a dev dependency. Nothing else yet.
</pasted_content id="2b91">
````
