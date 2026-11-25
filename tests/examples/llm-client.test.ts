import { describe, expect, it, vi } from "vitest";

import {
  LlmBudgetExceededError,
  createLlmClient,
  createLlmClientFromEnv,
  parseJsonReply,
} from "../../examples/evidence-starter/llm-client.js";

function chatResponse(content: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

const base = {
  baseUrl: "https://llm.example/v1/",
  apiKey: "test-key",
  model: "test/model:free",
  minIntervalMs: 0,
  sleep: async () => {},
};

describe("parseJsonReply", () => {
  it("parses plain JSON", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON inside a code fence", () => {
    expect(parseJsonReply('Here you go:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it("parses JSON surrounded by prose", () => {
    expect(parseJsonReply('Sure. {"a":3} Hope that helps.')).toEqual({ a: 3 });
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseJsonReply("no json here")).toThrow("did not contain a JSON object");
  });
});

describe("createLlmClient", () => {
  it("posts an OpenAI-compatible request and returns parsed JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(chatResponse('{"hasFact":false}'));
    const llm = createLlmClient({ ...base, fetch: fetchMock });

    await expect(llm.completeJson([{ role: "user", content: "hi" }])).resolves.toEqual({
      hasFact: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: "test/model:free",
      temperature: 0,
    });
    expect(llm.callsMade).toBe(1);
  });

  it("retries once after a 429 and honours Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(chatResponse('{"ok":true}'));

    const llm = createLlmClient({ ...base, fetch: fetchMock, sleep });

    await expect(llm.completeJson([])).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(llm.callsMade).toBe(2);
  });

  it("throws a readable error for a non-retryable failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("bad key", { status: 401 }));
    const llm = createLlmClient({ ...base, fetch: fetchMock });

    await expect(llm.completeJson([])).rejects.toThrow("LLM request failed (401)");
  });

  it("stops at the per-run call budget", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => chatResponse('{"a":1}'));
    const llm = createLlmClient({ ...base, fetch: fetchMock, maxCallsPerRun: 2 });

    await llm.completeJson([]);
    await llm.completeJson([]);

    await expect(llm.completeJson([])).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("spaces calls by the minimum interval", async () => {
    let clock = 1_000;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => chatResponse('{"a":1}'));
    const llm = createLlmClient({
      ...base,
      fetch: fetchMock,
      sleep,
      now: () => clock,
      minIntervalMs: 3000,
    });

    await llm.completeJson([]);
    await llm.completeJson([]);

    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("rejects a reply with no message content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const llm = createLlmClient({ ...base, fetch: fetchMock });

    await expect(llm.completeJson([])).rejects.toThrow("no message content");
  });
});

describe("createLlmClientFromEnv", () => {
  it("returns null when no LLM is configured", () => {
    expect(createLlmClientFromEnv({})).toBeNull();
  });

  it("requires all three settings together", () => {
    expect(() => createLlmClientFromEnv({ LLM_API_KEY: "x" })).toThrow(
      "Set all of LLM_BASE_URL, LLM_API_KEY and LLM_MODEL",
    );
  });

  it("builds a client from complete settings", () => {
    const llm = createLlmClientFromEnv({
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "some/model:free",
      LLM_MAX_CALLS: "10",
    });

    expect(llm?.model).toBe("some/model:free");
  });

  it("rejects an invalid numeric setting", () => {
    expect(() =>
      createLlmClientFromEnv({
        LLM_BASE_URL: "https://x.example/v1",
        LLM_API_KEY: "k",
        LLM_MODEL: "m",
        LLM_MAX_CALLS: "many",
      }),
    ).toThrow("LLM_MAX_CALLS must be a non-negative integer");
  });
});
