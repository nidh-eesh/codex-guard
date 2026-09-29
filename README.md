# Codex Guard

A guardrail agent for engineering teams, built on Cloudflare. Paste a diff and get feedback on whether it follows your workspace's rules.

- **Review a diff:** paste the output of `git diff` into the review box. Llama 3.3 on Workers AI checks it against the workspace's active rules and returns a verdict (pass, fail or incomplete) with each finding's rule, file and line.
- **Manage the rules in chat:** list them, add custom rules, switch off recommended ones with a reason, or restore them. A person approves every change before it happens. Locked rules, such as `no-secrets`, can't be switched off.
- **Workspaces are links:** opening the app creates a workspace at `/w/<id>`. Anyone with the link has full access to that workspace, so share it like a password.

[`DESIGN.md`](DESIGN.md) describes how it works and [`docs/DECISIONS.md`](docs/DECISIONS.md) records why.

## How it works

- Each workspace is a `ChatAgent` (Agents SDK, a Durable Object with SQLite) that stores the rules and the chat, and pushes the rules and the budget meter to the browser as agent state.
- A review runs as a `ReviewWorkflow`: the diff is split into numbered chunks, each chunk is reviewed by a model with no tools, and every finding is checked against the chunk and the rules before it's shown. A regex check for keys runs over every added line.
- Diffs never reach the chat model; it sees only each finding's rule, file and line.
- Cost controls: a per-IP rate limit (3 reviews and 10 chat turns a minute), and daily budgets of 6,000 neurons for reviews and 3,000 for chat, kept in a `NeuronBudget` Durable Object per UTC day. A meter on the page shows what's left; it resets at 00:00 UTC (05:30 IST).

## Requirements

- Node.js 24 (what CI uses)
- A Cloudflare account. The Free plan is enough: its 10,000 neurons a day cover the review and chat budgets with 1,000 to spare.
- Wrangler logged in to that account, even for local development: the Workers AI binding always calls the real service.

## Set up

```sh
git clone <this repository>
cd codex-guard
npm ci
npx wrangler login
```

If `npm ci` fails while building `sharp` against a globally installed libvips, run it as `SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci`.

## Run locally

```sh
npm run dev
```

Open the URL it prints (http://localhost:5173 by default). The home page opens your last workspace, or creates one.

Local development differs from production in a few ways:

- **It spends real neurons.** Reviews and chat call Workers AI on your account, but the budget meter counts only its own local state, not what the deployed app or the evals spend.
- **Rate limits aren't reliable.** The local simulator forgets its counts after about 10 seconds idle, so test a limit with requests a few seconds apart (D23).
- **Headers from `public/_headers` aren't applied** by the dev server. `npx vite preview` serves the built Worker as it will be deployed.
- **State lives in `.wrangler/state`.** Delete that folder to start from nothing.

## Check and test

```sh
npm run check   # formatting, lint, types
npm test        # unit tests; no model calls
```

The evals call the real model and spend neurons from your account:

```sh
npm run eval                # reviews the demo diffs in fixtures/reviews and checks each verdict
npm run eval:findings-cap   # measures output tokens per finding (D21)
```

## Deploy

1. Check the account: `npx wrangler whoami` shows where the Worker will be deployed.
2. Check the rate limiters: `namespace_id` `1001` and `1002` in `wrangler.jsonc` must not be used by another Worker in the account, or they will share its counters.
3. Deploy:

   ```sh
   npm run deploy
   ```

   This builds the app and runs `wrangler deploy`. The first deploy creates the `ChatAgent` and `NeuronBudget` Durable Objects, the review workflow and both rate limiters. It prints the Worker's URL.

4. Run the smoke test against that URL:

   ```sh
   npm run smoke -- https://codex-guard.<your-subdomain>.workers.dev
   ```

   It checks that `/agents/neuron-budget/*` returns 404, that an uppercase workspace ID returns 400, and that pages send `Referrer-Policy: no-referrer`. It creates no workspace and calls no model.

Keep Workers observability off (`"observability": { "enabled": false }`): invocation logs would record workspace links, which are the credentials (D16).

## Limits

- No authentication: the link is the only credential, and a leaked link can't be rotated.
- Diffs up to 50 KB.
- Lockfiles and binary files aren't reviewed, and a minified or generated file makes the verdict incomplete.

[`DESIGN.md`](DESIGN.md) §8 lists what's out of scope.

## Project layout

| Path                                               | What it holds                                               |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `src/server.ts`                                    | The `ChatAgent`, the route guard and the Worker entry point |
| `src/app.tsx`, `src/client.tsx`                    | The React app                                               |
| `src/review-workflow.ts`, `src/review-pipeline.ts` | The review: split, review each chunk, validate, combine     |
| `src/diff-split.ts`, `src/token-budget.ts`         | Chunking and the per-call token budget                      |
| `src/finding-validation.ts`                        | Checks each finding against the chunk and the rules         |
| `src/active-rules.ts`, `src/rules.ts`              | The starter pack and which rules are active                 |
| `src/neuron-budget.ts`, `src/budget-ledger.ts`     | The daily budgets                                           |
| `src/rate-limit.ts`                                | The per-IP limits                                           |
| `src/model-config.ts`                              | The model ID, context window, maximum output and prices     |
| `evals/`, `fixtures/reviews/`                      | Evals against the real model, and their demo diffs          |
| `scripts/smoke.sh`                                 | The post-deploy smoke test                                  |
