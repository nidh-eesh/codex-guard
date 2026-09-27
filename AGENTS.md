# AGENTS.md - Codex Guard

Instructions for AI coding agents working in this repo. `DESIGN.md` is the source of truth for behaviour; if a change conflicts with it, stop and ask.

## Invariants - never break these

- The review model gets **no tools**. Never pass tools to the review call.
- The chat model's tools are defined on the server only. Never pass `options.clientTools` (tool schemas sent by the browser) to the model.
- Diffs and review free text (`message`, `suggestion`) never reach the chat model.
- Every review-model output is validated (Zod shape + `ruleId` exists + `file` is in the chunk + `line` is one of that file's numbered lines) before it is shown or stored.
- Active rules always include every locked starter rule; locked rules can never be switched off or deleted.
- `addRule`, `removeRule` and `restoreRule` always require human approval; rules change only inside those tools' `execute`.
- Workspace IDs are validated before being used as an agent instance name, and only the lowercase form is accepted (the browser lowercases; the server rejects anything else).
- No credentials in code or commits (gitleaks in CI). Never log diffs, findings, request paths or workspace IDs. Redact matched secrets in stored findings. This repo follows its own starter pack.
- The model config (ID, context window, maximum output, prices) lives in one config module; never hard-code a model ID or context size elsewhere.
- `MAX_DIFF_BYTES = 50_000`, checked with `TextEncoder().encode(diff).length`; the Zod schema uses the same check.

## Conventions

- TypeScript strict mode. Zod at every boundary (tool inputs, model outputs, request params).
- Error messages match `DESIGN.md` ##5 exactly.
- Diff chunks are packed first-fit: each file or piece goes into the first open chunk with room, not just the last one. D6's at-most-2-chunks bound depends on it; a property test checks that any diff up to 18k tokens packs into at most 2 chunks, none over 12k.
- Vitest tests for every rule-logic change and every error message.
- Small commits, one concern each.
- When a decision in `DESIGN.md` changes, update `DESIGN.md` in the same commit.

## Author-owned modules

The security and correctness-critical logic is written by the author, so every guarantee in `DESIGN.md` ##7 has a human owner. For these modules, agents review, explain, find bugs, and propose test cases; the implementation itself is the author's:

- Active-rules resolution (starter pack − disabled defaults + custom rules; locked rules always active)
- Finding validation (Zod schema plus the `ruleId`, `file` and line checks)
- Diff splitting and the per-call token budget

## Logging

- Every prompt is appended to `PROMPTS.md` automatically by a hook. Never edit or delete entries there.
- When a design decision is made in conversation, propose an entry for `docs/DECISIONS.md` and wait for confirmation before writing it.
