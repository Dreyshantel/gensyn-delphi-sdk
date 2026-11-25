import { describe, it, expect, vi } from "vitest";
import { runMarketPipeline } from "../../examples/evidence-starter/market-pipeline.js";

const markets = [
  {
    address: "0xhigh",
    question: "Will event X happen?",
    status: "open",
    odds: { yes: 50, no: 50 },
    evidenceCutoffAt: "2026-12-01T00:00:00Z",
    dataSources: ["source1", "source2", "source3"],
  },
  {
    address: "0xclosed",
    question: "Has event Y happened?",
    status: "closed",
    odds: { yes: 50, no: 50 },
    evidenceCutoffAt: "2026-12-01T00:00:00Z",
    dataSources: [],
  },
];

describe("market pipeline", () => {
  it("discovers, filters and ranks markets", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ markets }), { status: 200 }),
    );

    const result = await runMarketPipeline({
      siteUrl: "https://competition.test",
      fetch: fetcher as unknown as typeof fetch,
      now: Date.parse("2026-11-20T00:00:00Z"),
      researchability: { "0xhigh": 1 },
    });

    expect(result.discoveredCount).toBe(2);
    expect(result.openCount).toBe(1);
    expect(result.rankedMarkets[0].market.address).toBe("0xhigh");
  });

  it("returns empty rankings when no markets are open", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    );

    const result = await runMarketPipeline({
      siteUrl: "https://competition.test",
      fetch: fetcher as unknown as typeof fetch,
    });

    expect(result.discoveredCount).toBe(0);
    expect(result.openCount).toBe(0);
    expect(result.rankedMarkets).toEqual([]);
  });
});
