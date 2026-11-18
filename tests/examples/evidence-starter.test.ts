import { describe, it, expect, vi } from "vitest";
import { EvidenceClient } from "../../src/client/evidence.js";
import { findFact, pickMarkets, run, type MarketCard } from "../../examples/evidence-starter/agent.js";

const card = (address: string, yes: number, extra: Partial<MarketCard> = {}): MarketCard => ({
  address, question: `Q ${address}`, status: "open", odds: { yes, no: 1 - yes },
  evidenceCutoffAt: "2999-01-01T00:00:00Z", dataSources: [], ...extra,
});
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

describe("evidence starter", () => {
  it("picks open markets in the 20% to 80% band before the cutoff", () => {
    const picked = pickMarkets([
      card("0xlow", 0.19), card("0xa", 0.2), card("0xb", 55), card("0xc", 0.8), card("0xhigh", 0.81),
      card("0xsettled", 0.5, { status: "settled" }),
      card("0xcutoff", 0.5, { evidenceCutoffAt: "2000-01-01T00:00:00Z" }),
    ]);
    expect(picked.map((m) => m.address)).toEqual(["0xa", "0xb", "0xc"]);
  });

  it("reads /markets.json, submits 1 dated fact with a source and polls the result", async () => {
    const site = vi.fn(async () => json([card("0xlow", 0.1), card("0xm", 0.5), card("0xn", 0.6)]));
    const api = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ version: "v2", url: "https://t", acceptedAt: "2026-11-01T00:00:00Z" }))
      .mockResolvedValueOnce(json({ canSubmit: true, remainingOnMarket: 3, rateLimit: { resetAt: "t" } }))
      .mockResolvedValueOnce(json({ id: "s1", createdAt: "t", status: "queued", markets: [] }))
      .mockResolvedValueOnce(json({ id: "s1", createdAt: "t", status: "judged", markets: [] }));
    const client = new EvidenceClient({ baseUrl: "https://app.test/v1", apiKey: "k", fetch: api });
    const fact = { date: "2026-11-16", text: "X reported Y.", source: "https://src.test/a" };

    const result = await run({
      siteUrl: "https://site.test", client, fetch: site as unknown as typeof fetch,
      findFact: async () => fact, log: () => {},
    });

    expect(site).toHaveBeenCalledWith("https://site.test/markets.json");
    expect(result?.status).toBe("judged");
    expect(api.mock.calls[0][0]).toBe("https://app.test/v1/terms");
    expect(api.mock.calls[1][0]).toBe("https://app.test/v1/markets/0xm/entry-state");
    const [url, init] = api.mock.calls[2];
    expect(url).toBe("https://app.test/v1/submissions");
    const form = init!.body as FormData;
    expect(form.get("note")).toBe("As of 2026-11-16: X reported Y.");
    expect(form.getAll("links[]")).toEqual(["https://src.test/a"]);
    expect(form.get("marketAddress")).toBe("0xm");
    expect(form.has("termsAccepted")).toBe(false);
    expect(api.mock.calls[3][0]).toBe("https://app.test/v1/submissions/s1");
    expect(api).toHaveBeenCalledTimes(4);
  });

  const notAccepted = () => json({ version: "v2", url: "https://t", acceptedAt: null });
  const runOnce = (api: typeof fetch, acceptTerms?: string, log: (...a: unknown[]) => void = () => {}) =>
    run({
      siteUrl: "https://site.test", acceptTerms, log,
      client: new EvidenceClient({ baseUrl: "https://app.test/v1", apiKey: "k", fetch: api }),
      fetch: (async () => json({ markets: [card("0xm", 0.5)] })) as typeof fetch,
      findFact: async () => ({ date: "d", text: "t", source: "s" }),
    });

  it("does not accept the terms or submit without ACCEPT_TERMS of the current version", async () => {
    for (const acceptTerms of [undefined, "v1"]) {
      const api = vi.fn<typeof fetch>().mockResolvedValueOnce(notAccepted());
      const log = vi.fn();
      expect(await runOnce(api, acceptTerms, log)).toBeNull();
      expect(api).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining("https://t, then set ACCEPT_TERMS=v2"));
    }
  });

  it("accepts the terms once when ACCEPT_TERMS is the current version, then submits", async () => {
    const api = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(notAccepted())
      .mockResolvedValueOnce(json({ version: "v2", acceptedAt: "2026-11-17T00:00:00Z" }))
      .mockResolvedValueOnce(json({ canSubmit: true, remainingOnMarket: 3, rateLimit: { resetAt: "t" } }))
      .mockResolvedValueOnce(json({ id: "s1", createdAt: "t", status: "rejected", markets: [] }));
    expect((await runOnce(api, "v2"))?.status).toBe("rejected");
    expect(api.mock.calls.map((c) => c[0])).toEqual([
      "https://app.test/v1/terms",
      "https://app.test/v1/terms/acceptance",
      "https://app.test/v1/markets/0xm/entry-state",
      "https://app.test/v1/submissions",
    ]);
    expect(JSON.parse(api.mock.calls[1][1]!.body as string)).toEqual({ termsVersion: "v2" });
  });

  it("default findFact needs MARKET_ADDRESS and matches only that market", async () => {
    const env = { FACT: "f", FACT_SOURCE: "https://s", FACT_DATE: "2026-11-16" };
    expect(await findFact(card("0xm", 0.5), env)).toBeNull();
    expect(await findFact(card("0xm", 0.5), { ...env, MARKET_ADDRESS: "0xOTHER" })).toBeNull();
    expect(await findFact(card("0xm", 0.5), { ...env, MARKET_ADDRESS: "0xM" }))
      .toEqual({ date: "2026-11-16", text: "f", source: "https://s" });
  });

  it("says so when MARKET_ADDRESS is not among the picked markets", async () => {
    vi.stubEnv("MARKET_ADDRESS", "0xclosed");
    const log = vi.fn();
    const client = new EvidenceClient({ baseUrl: "https://app.test/v1", apiKey: "k", fetch: vi.fn<typeof fetch>() });
    await run({ siteUrl: "https://site.test", client, log,
      fetch: (async () => json([card("0xm", 0.5), card("0xclosed", 0.5, { status: "settled" })])) as typeof fetch });
    vi.unstubAllEnvs();
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("MARKET_ADDRESS 0xclosed is not among the picked markets"));
  });
});
