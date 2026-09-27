import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: unit tests run in Node and don't need the
// Cloudflare, React or Tailwind plugins.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"]
  }
});
