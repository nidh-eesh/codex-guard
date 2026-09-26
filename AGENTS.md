# AGENTS.md - Codex Guard

Instructions for AI coding agents working in this repo. `DESIGN.md` is the source of truth for behaviour; if a change conflicts with it, stop and ask.

## Invariants - never break these

- The review model gets **no tools**. Never pass tools to the review call.
- Every model output is validated (Zod shape + `ruleId` exists + `line` inside the chunk) before it is shown or stored.
- Locked rules can never be switched off or deleted.
- `addRule` and `removeRule` always require human approval.
- Workspace IDs are validated before being used as an agent instance name.
- No secrets in code, logs, commits, or prompts. This repo follows its own starter pack.
- The model ID lives in one config constant; never hard-code it elsewhere.
- Use TextEncoder().encode(diff).length for input byte limit

## Conventions

- TypeScript strict mode. Zod at every boundary (tool inputs, model outputs, request params).
- Error messages match `DESIGN.md` ##5 exactly.
- Vitest tests for every rule-logic change and every error message.
- Small commits, one concern each.
- When a decision in `DESIGN.md` changes, update `DESIGN.md` in the same commit.

## Author-owned modules

The security and correctness-critical logic is written by the author, so every guarantee in `DESIGN.md` ##7 has a human owner. For these modules, agents review, explain, find bugs, and propose test cases; the implementation itself is the author's:

- Active-rules resolution (starter pack − disabled defaults + custom rules)
- Finding validation (Zod schema plus the `ruleId` and line-range checks)
- Diff splitting and the per-call token budget

## Logging

- Every prompt is appended to `PROMPTS.md` automatically by a hook. Never edit or delete entries there.
- When a design decision is made in conversation, propose an entry for `docs/DECISIONS.md` and wait for confirmation before writing it.
