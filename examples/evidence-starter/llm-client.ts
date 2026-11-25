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
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface LlmMessage {
  role: "system" | "user";
  content: string;
}

export interface LlmClient {
  /** Sends the messages and returns the parsed JSON object the model replied with. */
  completeJson(messages: LlmMessage[]): Promise<unknown>;
  /** Calls made so far in this run. */
  readonly callsMade: number;
  readonly model: string;
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

  let callsMade = 0;
  let lastCallAt = 0;

  async function send(messages: LlmMessage[]): Promise<Response> {
    const wait = lastCallAt + minIntervalMs - now();

    if (lastCallAt > 0 && wait > 0) {
      await sleep(wait);
    }

    lastCallAt = now();

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

    async completeJson(messages) {
      // A retry counts against the budget too: providers count failed calls.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (callsMade >= maxCallsPerRun) {
          throw new LlmBudgetExceededError(maxCallsPerRun);
        }

        callsMade++;

        const response = await send(messages);

        if (
          attempt === 0 &&
          (response.status === 429 || response.status >= 500)
        ) {
          const retryAfter = Number(response.headers.get("retry-after"));

          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter, 60) * 1000
              : 10_000,
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

        const content = (
          body as { choices?: { message?: { content?: unknown } }[] }
        ).choices?.[0]?.message?.content;

        if (typeof content !== "string" || !content.trim()) {
          throw new Error("LLM response had no message content");
        }

        return parseJsonReply(content);
      }

      throw new Error("LLM request failed after a retry");
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
    throw new Error(
      "Set all of LLM_BASE_URL, LLM_API_KEY and LLM_MODEL, or none of them",
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
  });
}
