/**
 * Minimal client for any OpenAI-compatible chat-completions API.
 *
 * One client covers the free tiers that matter for this agent:
 *   - OpenRouter  (LLM_BASE_URL=https://openrouter.ai/api/v1, a model ending in ":free")
 *   - Groq        (LLM_BASE_URL=https://api.groq.com/openai/v1)
 *   - Gemini      (LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai)
 *   - a local model served by Ollama or LM Studio
 *
 * Free tiers are limited by requests, not tokens, so this client:
 *   - spaces calls by `minIntervalMs` (per-minute limits),
 *   - refuses to exceed `maxCallsPerRun` (daily limits),
 *   - retries a 429/5xx once, honouring Retry-After.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Minimum gap between calls. Default 3500 ms (about 17 calls/minute). */
  minIntervalMs?: number;
  /** Hard ceiling on calls for one agent run. Default 40. */
  maxCallsPerRun?: number;
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number;
  /**
   * Token budget per rolling minute. Default 7000 (Groq's free tier allows
   * 8000 TPM on openai/gpt-oss-120b). Calls wait until the estimate fits.
   */
  tokensPerMinute?: number;
  /** Cap on output tokens, reasoning included. Default 2048. */
  maxCompletionTokens?: number;
  /** For reasoning models such as gpt-oss on Groq: "low" | "medium" | "high". */
  reasoningEffort?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  rateLimitWaits: number;
}

export interface LlmClient {
  /** Sends the messages and returns the parsed JSON object the model replied with. */
  completeJson(messages: LlmMessage[]): Promise<unknown>;
  /** Calls made so far in this run. */
  readonly callsMade: number;
  readonly model: string;
  /** Token usage reported by the provider (optional for test doubles). */
  readonly usage?: LlmUsage;
}

/** Rough token estimate: about 4 characters per token for English text. */
export function estimateTokens(messages: LlmMessage[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
}

export class LlmBudgetExceededError extends Error {
  constructor(limit: number) {
    super(`LLM call budget for this run is used up (${limit} calls)`);
    this.name = "LlmBudgetExceededError";
  }
}

/**
 * Extracts the first JSON object from a model reply.
 * Free models often wrap JSON in prose or ```json fences.
 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to looser extraction.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);

  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fall through.
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error("LLM reply did not contain a JSON object");
}

export function createLlmClient(config: LlmConfig): LlmClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("LLM_BASE_URL must be an http(s) URL");
  }

  if (!config.apiKey.trim()) {
    throw new Error("LLM_API_KEY is required");
  }

  if (!config.model.trim()) {
    throw new Error("LLM_MODEL is required");
  }

  const minIntervalMs = config.minIntervalMs ?? 3500;
  const maxCallsPerRun = config.maxCallsPerRun ?? 40;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const fetchFn = config.fetch ?? ((...args) => fetch(...args));
  const sleep =
    config.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = config.now ?? Date.now;

  const tokensPerMinute = config.tokensPerMinute ?? 7000;
  const maxCompletionTokens = config.maxCompletionTokens ?? 2048;

  let callsMade = 0;
  let lastCallAt = 0;
  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, rateLimitWaits: 0 };
  /** Tokens spent in the last minute, for per-minute token limits. */
  let window: { at: number; tokens: number }[] = [];

  async function waitForTokenBudget(estimate: number): Promise<void> {
    // A single call larger than the whole budget still goes out, alone.
    const needed = Math.min(estimate, tokensPerMinute);

    for (;;) {
      const cutoff = now() - 60_000;
      window = window.filter((entry) => entry.at > cutoff);
      const used = window.reduce((sum, entry) => sum + entry.tokens, 0);

      if (used + needed <= tokensPerMinute || window.length === 0) {
        return;
      }

      await sleep(Math.max(250, window[0].at + 60_000 - now()));
    }
  }

  async function send(messages: LlmMessage[]): Promise<Response> {
    const wait = lastCallAt + minIntervalMs - now();

    if (lastCallAt > 0 && wait > 0) {
      await sleep(wait);
    }

    // Reserve the prompt plus a typical answer (reasoning models think first).
    const estimate = estimateTokens(messages) + Math.min(1200, maxCompletionTokens);
    await waitForTokenBudget(estimate);

    lastCallAt = now();
    window.push({ at: lastCallAt, tokens: estimate });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0,
          max_completion_tokens: maxCompletionTokens,
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        }),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get callsMade() {
      return callsMade;
    },

    model: config.model,

    get usage() {
      return { ...usage };
    },

    async completeJson(messages) {
      // Up to 3 retries on rate limits or server errors. Retries count
      // against the run budget too: providers count failed calls.
      const maxAttempts = 4;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (callsMade >= maxCallsPerRun) {
          throw new LlmBudgetExceededError(maxCallsPerRun);
        }

        callsMade++;

        const response = await send(messages);

        if (
          attempt < maxAttempts - 1 &&
          (response.status === 429 || response.status >= 500)
        ) {
          const retryAfter = Number(response.headers.get("retry-after"));

          usage.rateLimitWaits++;
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter, 90) * 1000
              : 15_000 * (attempt + 1),
          );

          continue;
        }

        const text = await response.text();

        if (!response.ok) {
          throw new Error(
            `LLM request failed (${response.status}): ${text.slice(0, 300)}`,
          );
        }

        let body: unknown;

        try {
          body = JSON.parse(text);
        } catch {
          throw new Error("LLM response was not valid JSON");
        }

        const reported = (body as { usage?: Record<string, unknown> }).usage;

        if (reported) {
          const prompt = Number(reported.prompt_tokens) || 0;
          const completion = Number(reported.completion_tokens) || 0;
          const total = Number(reported.total_tokens) || prompt + completion;

          usage.promptTokens += prompt;
          usage.completionTokens += completion;
          usage.totalTokens += total;

          // Replace this call's estimate with what the provider counted.
          const entry = window[window.length - 1];

          if (entry && total > 0) {
            entry.tokens = total;
          }
        }

        const content = (
          body as { choices?: { message?: { content?: unknown } }[] }
        ).choices?.[0]?.message?.content;

        if (typeof content !== "string" || !content.trim()) {
          throw new Error("LLM response had no message content");
        }

        return parseJsonReply(content);
      }

      throw new Error("LLM request still rate-limited after 3 retries");
    },
  };
}

/**
 * Builds a client from the environment, or returns null when no LLM is
 * configured (the agent then runs without one and needs a human to
 * choose each direction).
 */
export function createLlmClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LlmClient | null {
  const baseUrl = env.LLM_BASE_URL?.trim();
  const apiKey = env.LLM_API_KEY?.trim();
  const model = env.LLM_MODEL?.trim();

  if (!baseUrl && !apiKey && !model) {
    return null;
  }

  if (!baseUrl || !apiKey || !model) {
    const missing = [
      ["LLM_BASE_URL", baseUrl],
      ["LLM_API_KEY", apiKey],
      ["LLM_MODEL", model],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    throw new Error(
      `Set all of LLM_BASE_URL, LLM_API_KEY and LLM_MODEL, or none of them. Missing: ${missing.join(", ")}`,
    );
  }

  const optionalInt = (name: string): number | undefined => {
    const raw = env[name]?.trim();

    if (!raw) {
      return undefined;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative integer`);
    }

    return value;
  };

  return createLlmClient({
    baseUrl,
    apiKey,
    model,
    minIntervalMs: optionalInt("LLM_MIN_INTERVAL_MS"),
    maxCallsPerRun: optionalInt("LLM_MAX_CALLS"),
    tokensPerMinute: optionalInt("LLM_TOKENS_PER_MINUTE"),
    maxCompletionTokens: optionalInt("LLM_MAX_COMPLETION_TOKENS"),
    reasoningEffort: env.LLM_REASONING_EFFORT?.trim() || undefined,
  });
}
