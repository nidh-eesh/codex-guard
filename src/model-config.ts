/**
 * The model config: the only place the model ID, context window, maximum
 * output and prices are written down (AGENTS.md). The chunk budget and the
 * neuron estimate are computed from these values, so switching models means
 * editing this file only.
 *
 * Values from developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
 * and /workers-ai/platform/pricing/, checked 2026-09-26.
 */
export interface ModelConfig {
  /** Workers AI model ID. */
  readonly id: keyof AiModels;
  /** The model's name, as the UI shows it. */
  readonly name: string;
  /** Tokens per call, prompt and answer together. */
  readonly contextWindow: number;
  /**
   * Sent as `max_tokens` on every call and reserved out of the context
   * window. Must be set explicitly: the Workers AI default is 256.
   */
  readonly maxOutputTokens: number;
  readonly neuronsPerMillionInputTokens: number;
  readonly neuronsPerMillionOutputTokens: number;
}

export const MODEL = {
  id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  name: "Llama 3.3 70B Instruct (FP8, fast)",
  contextWindow: 24_000,
  maxOutputTokens: 3_000,
  neuronsPerMillionInputTokens: 26_668,
  neuronsPerMillionOutputTokens: 204_805
} as const satisfies ModelConfig;

/** The model's page in the Workers AI docs, named after the last part of its ID. */
export function modelDocsUrl(model: Pick<ModelConfig, "id">): string {
  return `https://developers.cloudflare.com/workers-ai/models/${model.id.split("/").at(-1)}/`;
}
