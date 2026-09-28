import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { getPlatformProxy } from "wrangler";
import { MODEL } from "../src/model-config";
import type { RunStep } from "../src/review-pipeline";

/**
 * The real review model on Workers AI, through wrangler's remote AI binding.
 * Needs a Cloudflare login (`wrangler login`), and every call costs neurons.
 */
export async function connectReviewModel(): Promise<{
  model: LanguageModel;
  dispose: () => Promise<void>;
}> {
  const proxy = await getPlatformProxy<Env>({
    configPath: "wrangler.jsonc",
    persist: false
  });
  return {
    model: createWorkersAI({ binding: proxy.env.AI })(MODEL.id),
    dispose: proxy.dispose
  };
}

/** Runs a step in memory with the workflow's limit: at most 2 retries (D10). */
export const retryingStep: RunStep = async (_name, work) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};
