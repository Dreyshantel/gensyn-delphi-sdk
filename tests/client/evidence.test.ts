import { describe, it, expect, vi } from "vitest";
import { EvidenceClient, EvidenceApiError, TermsNotAcceptedError } from "../../src/client/evidence.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sub = (status: string) => ({ id: "s1", createdAt: "t", agentId: null, note: null, links: [], files: [], status, markets: [] });

function make(responses: Response[]) {
  const fetch = vi.fn(async () => responses.shift()!);
  const client = new EvidenceClient({
    baseUrl: "https://app.test/v1/",
    apiKey: "k",
    agentId: "agent-1",
    agentModel: "m",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { client, fetch };
}
const call = (f: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
};

describe("EvidenceClient", () => {
  it("sends bearer + agent headers and exposes response headers", async () => {
    const { client, fetch } = make([
      json(200, { submitsLeftThisHour: 1, hourEndsAt: "a", dailyCapLeft: 2, dailyCapResetAt: "b" }, {
        "X-Request-Id": "r1", "X-Contract-Version": "1.0.0", "X-Delphi-Warnings": "missing X-Agent-Harness",
        "RateLimit-Limit": "10", "RateLimit-Remaining": "9", "RateLimit-Reset": "30",
      }),
    ]);
    const r = await client.getLimits();
    const c = call(fetch);
    expect(c.url).toBe("https://app.test/v1/limits");
    expect(c.headers.Authorization).toBe("Bearer k");
    expect(c.headers["X-Agent-Id"]).toBe("agent-1");
    expect(c.headers["X-Agent-Harness"]).toBeUndefined();
    expect(r.meta).toMatchObject({
      requestId: "r1", contractVersion: "1.0.0", warnings: "missing X-Agent-Harness",
      rateLimit: { limit: 10, remaining: 9, reset: 30 },
    });
  });

  it("submits multipart with an automatic Idempotency-Key", async () => {
    const { client, fetch } = make([
      json(202, sub("queued"), { Location: "/v1/submissions/s1", "Retry-After": "5" }),
      json(202, sub("queued")),
    ]);
    const r = await client.submitEvidence({
      note: "n", links: ["https://a", "https://b"], files: [new Blob(["x"])], marketAddress: "0xabc",
    });
    const c = call(fetch);
    const form = c.init.body as FormData;
    expect(c.init.method).toBe("POST");
    expect(form.getAll("links[]")).toEqual(["https://a", "https://b"]);
    expect(form.getAll("files")).toHaveLength(1);
    expect(form.get("marketAddress")).toBe("0xabc");
    expect(form.has("termsAccepted")).toBe(false);
    expect(c.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.meta).toMatchObject({ location: "/v1/submissions/s1", retryAfterSeconds: 5 });

    await client.submitEvidence({ note: "n", idempotencyKey: "mine" });
    expect(call(fetch, 1).headers["Idempotency-Key"]).toBe("mine");
  });

  it("waitForSubmission honors abort", async () => {
    const { client, fetch } = make([json(200, sub("queued"), { "Retry-After": "60" })]);
    const pre = AbortSignal.abort(new Error("pre"));
    await expect(client.waitForSubmission("s1", { signal: pre })).rejects.toThrow("pre");
    expect(fetch).not.toHaveBeenCalled();
    const ac = new AbortController();
    const p = client.waitForSubmission("s1", { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("mid")), 20);
    await expect(p).rejects.toThrow("mid");
  });

  it("throws typed errors from the error object", async () => {
    const { client } = make([
      json(429, { error: { code: "rate_limited", message: "slow", retryable: true, retryAfterSeconds: 1200, field: null }, requestId: "r9" }),
      json(400, { error: { code: "invalid_request", message: "bad", retryable: false, field: "note" }, requestId: "r8" }),
    ]);
    const e1 = await client.getSubmission("s1").catch((e) => e);
    expect(e1).toBeInstanceOf(EvidenceApiError);
    expect(e1).toMatchObject({ status: 429, code: "rate_limited", retryable: true, retryAfterSeconds: 1200, requestId: "r9" });
    const e2 = await client.retrySubmission("s1").catch((e) => e);
    expect(e2).toMatchObject({ code: "invalid_request", field: "note", limit: null });
  });

  it("exposes the limit of rate_limited and the new codes", async () => {
    const { client } = make([
      json(429, { error: { code: "rate_limited", message: "hour", retryable: true, retryAfterSeconds: 60, field: null, limit: "hourly" } }),
      json(429, { error: { code: "cap_reached", message: "full", retryable: false, retryAfterSeconds: null, field: null } }),
      json(404, { error: { code: "market_not_found", message: "none", retryable: false, retryAfterSeconds: null, field: "marketAddress" } }),
    ]);
    expect(await client.submitEvidence({ note: "n" }).catch((e) => e)).toMatchObject({ code: "rate_limited", limit: "hourly" });
    expect(await client.submitEvidence({ note: "n" }).catch((e) => e)).toMatchObject({ code: "cap_reached", retryable: false, retryAfterSeconds: null });
    expect(await client.submitEvidence({ note: "n", marketAddress: "0xtypo" }).catch((e) => e)).toMatchObject({
      status: 404,
      code: "market_not_found",
      field: "marketAddress",
    });
  });

  it("reads and accepts the terms", async () => {
    const { client, fetch } = make([
      json(200, { version: "v2", url: "https://t", acceptedAt: null }),
      json(200, { version: "v2", acceptedAt: "2026-11-17T00:00:00Z" }),
    ]);
    expect((await client.getTerms()).data).toEqual({ version: "v2", url: "https://t", acceptedAt: null });
    expect(call(fetch, 0).url).toBe("https://app.test/v1/terms");
    expect((await client.acceptTerms("v2")).data).toEqual({ version: "v2", acceptedAt: "2026-11-17T00:00:00Z" });
    const c = call(fetch, 1);
    expect(c.url).toBe("https://app.test/v1/terms/acceptance");
    expect(c.init.method).toBe("POST");
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(c.init.body as string)).toEqual({ termsVersion: "v2" });
  });

  it("throws TermsNotAcceptedError with the version and URL on 403 terms_not_accepted", async () => {
    const terms = { version: "v2", url: "https://t" };
    const { client } = make([
      json(403, { error: { code: "terms_not_accepted", message: "accept", retryable: false, field: null, terms }, requestId: "r7" }),
      json(403, { error: { code: "forbidden", message: "region", retryable: false, field: null } }),
    ]);
    const e = await client.submitEvidence({ note: "n" }).catch((x) => x);
    expect(e).toBeInstanceOf(TermsNotAcceptedError);
    expect(e).toBeInstanceOf(EvidenceApiError);
    expect(e).toMatchObject({ name: "TermsNotAcceptedError", status: 403, code: "terms_not_accepted", terms, requestId: "r7" });
    const f = await client.submitEvidence({ note: "n" }).catch((x) => x);
    expect(f).not.toBeInstanceOf(TermsNotAcceptedError);
    expect(f).toMatchObject({ code: "forbidden" });
  });

  it("covers list, entry-state and retry routes", async () => {
    const { client, fetch } = make([
      json(200, { items: [], nextCursor: null }),
      json(200, { canSubmit: true, remainingOnMarket: 3, rateLimit: { resetAt: "x" } }),
      json(202, sub("queued")),
    ]);
    await client.listSubmissions({ market: "0xm", agentId: "agent-1", limit: 5 });
    await client.getEntryState("0xm");
    await client.retrySubmission("s1");
    expect(call(fetch, 0).url).toBe("https://app.test/v1/submissions?market=0xm&agentId=agent-1&limit=5");
    expect(call(fetch, 1).url).toBe("https://app.test/v1/markets/0xm/entry-state");
    expect(call(fetch, 2)).toMatchObject({ url: "https://app.test/v1/submissions/s1/retry" });
    expect(call(fetch, 2).init.method).toBe("POST");
  });

  it("polls until terminal, honoring Retry-After", async () => {
    vi.useFakeTimers();
    const { client, fetch } = make([
      json(200, sub("queued"), { "Retry-After": "2" }),
      json(200, sub("judging"), { "Retry-After": "3" }),
      json(200, sub("judged")),
    ]);
    const p = client.waitForSubmission("s1");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).data.status).toBe("judged");
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
