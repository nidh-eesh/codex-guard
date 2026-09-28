import { defineConfig } from "vitest/config";

// Evals call the real review model on Workers AI: they need a Cloudflare
// login, cost neurons, and don't run in CI. `npm run eval`
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    // Show each eval's printed results, passing or not
    silent: false,
    testTimeout: 180_000,
    hookTimeout: 180_000
  }
});
