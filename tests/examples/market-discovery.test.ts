import { describe, it, expect, vi } from "vitest";
import {
  parseMarkets,
  discoverMarkets,
  getOpenMarkets,
  getTimeRemaining,
  type DiscoveredMarket,
} from "../../examples/evidence-starter/market-discovery.js";

const market = (
  address: string,
  extra: Partial<DiscoveredMarket> = {},
): DiscoveredMarket => ({
  address,
  question: `Question for ${address}`,
  status: "open",
  odds: { yes: 0.5, no: 0.5 },
  evidenceCutoffAt: "2026-12-01T00:00:00Z",
  dataSources: [],
  ...extra,
});

describe("market discovery", () => {
  it("parses an array response", () => {
    expect(parseMarkets([market("0x1")])).toHaveLength(1);
  });

  it("parses an object containing markets", () => {
    expect(parseMarkets({ markets: [market("0x1")] })).toHaveLength(1);
  });

  it("rejects an invalid response shape", () => {
    expect(() => parseMarkets({ results: [] })).toThrow(
      "Invalid markets response",
    );
  });

  it("rejects malformed market data", () => {
    expect(() =>
      parseMarkets([{ address: "0x1", odds: { yes: "high", no: 0.5 } }]),
    ).toThrow();
  });

  it("discovers markets from the competition endpoint", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([market("0x1")]), { status: 200 }),
    );

    const result = await discoverMarkets({
      siteUrl: "https://competition.test",
      fetch: fetcher as unknown as typeof fetch,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://competition.test/markets.json",
    );
    expect(result).toHaveLength(1);
  });

  it("throws when the market endpoint returns an error", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));

    await expect(
      discoverMarkets({
        siteUrl: "https://competition.test",
        fetch: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow("GET /markets.json failed: 503");
  });

  it("returns open markets before their cutoff regardless of odds", () => {
    const markets = [
      market("0xlow", { odds: { yes: 0.05, no: 0.95 } }),
      market("0xhigh", { odds: { yes: 0.95, no: 0.05 } }),
      market("0xclosed", { status: "closed" }),
      market("0xexpired", {
        evidenceCutoffAt: "2020-01-01T00:00:00Z",
      }),
    ];

    expect(getOpenMarkets(markets, Date.parse("2026-11-20T00:00:00Z"))
      .map((item) => item.address))
      .toEqual(["0xlow", "0xhigh"]);
  });

  it("calculates time remaining until the evidence cutoff", () => {
    const item = market("0x1", {
      evidenceCutoffAt: "2026-11-21T00:00:00Z",
    });

    expect(
      getTimeRemaining(item, Date.parse("2026-11-20T00:00:00Z")),
    ).toBe(24 * 60 * 60 * 1000);
  });

  it("returns zero when the cutoff has passed", () => {
    const item = market("0x1", {
      evidenceCutoffAt: "2026-11-19T00:00:00Z",
    });

    expect(
      getTimeRemaining(item, Date.parse("2026-11-20T00:00:00Z")),
    ).toBe(0);
  });
});

describe("lenient market parsing", () => {
  it("skips malformed entries and reports them when asked to", async () => {
    const { parseMarkets } = await import("../../examples/evidence-starter/market-discovery.js");
    const messages: string[] = [];
    const good = {
      address: "0xgood",
      question: "Will it happen?",
      status: "open",
      odds: { yes: 50, no: 50 },
      evidenceCutoffAt: "2026-12-01T00:00:00Z",
      dataSources: [],
    };

    const markets = parseMarkets([{ address: "0xbad" }, good], {
      skipInvalidMarkets: true,
      onInvalidMarket: (m) => messages.push(m),
    });

    expect(markets.map((m) => m.address)).toEqual(["0xgood"]);
    expect(messages).toEqual(["Skipped market: Market 0xbad has an invalid question"]);
  });

  it("still rejects the whole list by default", async () => {
    const { parseMarkets } = await import("../../examples/evidence-starter/market-discovery.js");

    expect(() => parseMarkets([{ address: "0xbad" }])).toThrow();
  });
});
