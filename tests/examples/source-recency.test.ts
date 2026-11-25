import { describe, expect, it } from "vitest";

describe("recent-source preference", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

  it("scores fresh sources up, stale ones down and undated ones neutral", async () => {
    const { recencyBonus } = await import("../../examples/evidence-starter/research-runner.js");

    expect(recencyBonus(daysAgo(1), now)).toBe(0.3);
    expect(recencyBonus(daysAgo(6), now)).toBe(0.2);
    expect(recencyBonus(daysAgo(20), now)).toBe(0);
    expect(recencyBonus(daysAgo(100), now)).toBe(-0.2);
    expect(recencyBonus(daysAgo(400), now)).toBe(-0.4);
    expect(recencyBonus(undefined, now)).toBe(0);
  });

  it("fetches yesterday's article before a years-old one with the same keywords", async () => {
    const { runMarketResearch } = await import("../../examples/evidence-starter/research-runner.js");
    const fetched: string[] = [];
    const title = "Federal Reserve interest rates decision December meeting";

    await runMarketResearch(
      {
        marketAddress: "0x1",
        marketQuestion: "Will the Federal Reserve cut interest rates at its December 2026 meeting?",
        resolutionCriteria: "YES if the Federal Reserve cuts interest rates in December 2026.",
        evidenceCutoffAt: "2026-12-10T00:00:00Z",
        suggestedDataSources: [],
      },
      {
        now,
        maxArticlesToFetch: 1,
        preferRecentSources: true,
        queryGenerator: async () => ({
          queries: ["a", "b", "c"].map((q) => ({ query: q, objective: "o", sourceTypes: ["news"] })),
        }),
        searchProvider: async (query) =>
          query.query === "a"
            ? [
                { title, url: "https://old.example/2024", sourceName: "Old", publishedAt: daysAgo(700) },
                { title, url: "https://new.example/today", sourceName: "New", publishedAt: daysAgo(1) },
              ]
            : [],
        articleFetcher: async (url) => {
          fetched.push(url);
          throw new Error("not needed");
        },
      },
    );

    expect(fetched).toEqual(["https://new.example/today"]);
  });
});
