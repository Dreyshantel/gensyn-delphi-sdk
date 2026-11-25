
import { describe, expect, it, vi } from "vitest";

import {
  runMarketResearchPipeline,
} from "../../examples/evidence-starter/market-research-pipeline.js";

import type {
  DiscoveredMarket,
} from "../../examples/evidence-starter/market-discovery.js";

import type {
  ResearchPlanningInput,
} from "../../examples/evidence-starter/research-planner.js";

import type {
  ResearchSearchProvider,
} from "../../examples/evidence-starter/source-discovery.js";

const NOW = new Date("2026-11-21T12:00:00Z").getTime();

function createMarket(
  address: string,
  question: string,
): DiscoveredMarket {
  return {
    address,
    question,
    status: "open",
    odds: {
      yes: 50,
      no: 50,
    },
    evidenceCutoffAt: "2026-12-01T23:59:59Z",
    dataSources: [
      "Official government sources",
      "Regulatory announcements",
      "Credible news reports",
    ],
  };
}

const markets = [
  createMarket(
    "0xmarket001",
    "Will Nigeria introduce a new digital banking policy?",
  ),
  createMarket(
    "0xmarket002",
    "Will the CBN announce a new interest rate?",
  ),
  createMarket(
    "0xmarket003",
    "Will Nigeria launch a new digital currency?",
  ),
];

const criteriaByMarket = {
  "0xmarket001":
    "YES if the Nigerian government officially announces the policy before the deadline.",
  "0xmarket002":
    "YES if the CBN officially announces a new interest rate before the deadline.",
};

function createOptions(
  overrides: Record<string, unknown> = {},
) {
  return {
    siteUrl: "https://competition.example",
    fetch: vi.fn(async () =>
      new Response(JSON.stringify(markets), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    ),
    now: NOW,
    resolutionCriteriaByMarket: criteriaByMarket,
    researchOptions: {
      searchProvider: vi.fn(
        async (_query: unknown) => [],
      ) as ResearchSearchProvider,
      articleFetcher: vi.fn(),
    },
    ...overrides,
  };
}

describe("market research pipeline", () => {
  it("discovers and ranks markets before researching them", async () => {
    const result = await runMarketResearchPipeline(
      createOptions(),
    );

    expect(result.discoveredCount).toBe(3);
    expect(result.openCount).toBe(3);
    expect(result.rankedCount).toBe(3);
    expect(result.researchedCount).toBe(2);
  });

  it("researches only markets with explicit resolution criteria", async () => {
    const result = await runMarketResearchPipeline(
      createOptions(),
    );

    const researchedAddresses = result.researches.map(
      (entry) => entry.market.address,
    );

    expect(researchedAddresses).toHaveLength(2);
    expect(researchedAddresses).not.toContain("0xmarket003");
    expect(result.skippedMarkets).toContain("0xmarket003");
  });

  it("passes the correct resolution criteria to the query generator", async () => {
    const generator = vi.fn(
      async (input: ResearchPlanningInput) => ({
        queries: [
          {
            query: `${input.marketQuestion} official announcement`,
            objective: "Find official announcements",
            sourceTypes: ["official"],
          },
          {
            query: `${input.marketQuestion} regulatory documents`,
            objective: "Find regulatory documents",
            sourceTypes: ["regulatory"],
          },
          {
            query: `${input.marketQuestion} independent reporting`,
            objective: "Find independent reporting",
            sourceTypes: ["news"],
          },
        ],
      }),
    );

    await runMarketResearchPipeline(
      createOptions({
        researchOptions: {
          queryGenerator: generator,
          searchProvider: vi.fn().mockResolvedValue([]),
          articleFetcher: vi.fn(),
        },
      }),
    );

    expect(generator).toHaveBeenCalledTimes(2);

    expect(generator).toHaveBeenCalledWith(
      expect.objectContaining({
        marketAddress: "0xmarket001",
        resolutionCriteria: criteriaByMarket["0xmarket001"],
      }),
    );

    expect(generator).toHaveBeenCalledWith(
      expect.objectContaining({
        marketAddress: "0xmarket002",
        resolutionCriteria: criteriaByMarket["0xmarket002"],
      }),
    );
  });

  it("respects the maximum number of markets to research", async () => {
    const result = await runMarketResearchPipeline(
      createOptions({
        maxMarketsToResearch: 1,
      }),
    );

    expect(result.researchedCount).toBe(1);
    expect(result.researches).toHaveLength(1);
  });

  it("does not research any market when no criteria are supplied", async () => {
    const result = await runMarketResearchPipeline(
      createOptions({
        resolutionCriteriaByMarket: {},
      }),
    );

    expect(result.researchedCount).toBe(0);
    expect(result.researches).toHaveLength(0);
    expect(result.skippedMarkets).toHaveLength(3);
  });

  it("rejects an invalid market research limit", async () => {
    await expect(
      runMarketResearchPipeline(
        createOptions({
          maxMarketsToResearch: 0,
        }),
      ),
    ).rejects.toThrow(
      "maxMarketsToResearch must be an integer between 1 and 10",
    );
  });

  it("matches resolution criteria regardless of address casing", async () => {
    const result = await runMarketResearchPipeline(
      createOptions({
        resolutionCriteriaByMarket: {
          "0xMARKET001": criteriaByMarket["0xmarket001"],
        },
      }),
    );

    expect(result.researchedCount).toBe(1);
    expect(result.researches[0].market.address).toBe("0xmarket001");
  });

  it("reports eligible markets excluded by the research limit", async () => {
    const result = await runMarketResearchPipeline(
      createOptions({
        maxMarketsToResearch: 1,
      }),
    );

    expect(result.researchedCount).toBe(1);
    expect(result.skippedMarkets).toHaveLength(2);
    expect(result.skippedMarkets).toContain("0xmarket003");
  });

  it("continues researching other markets when one market fails", async () => {
    const generator = vi.fn(
      async (input: ResearchPlanningInput) => {
        if (input.marketAddress === "0xmarket001") {
          throw new Error("Research planning failed");
        }

        return {
          queries: [
            {
              query: "official announcement",
              objective: "Find official announcements",
              sourceTypes: ["official"],
            },
            {
              query: "regulatory documents",
              objective: "Find regulatory documents",
              sourceTypes: ["regulatory"],
            },
            {
              query: "independent reporting",
              objective: "Find independent reporting",
              sourceTypes: ["news"],
            },
          ],
        };
      },
    );

    const result = await runMarketResearchPipeline(
      createOptions({
        researchOptions: {
          queryGenerator: generator,
          searchProvider: vi.fn().mockResolvedValue([]),
          articleFetcher: vi.fn(),
        },
      }),
    );

    expect(result.researchedCount).toBe(1);
    expect(result.researchFailures).toHaveLength(1);

    expect(result.researchFailures[0]).toEqual({
      marketAddress: "0xmarket001",
      reason: "Research planning failed",
    });

    expect(result.researches[0].market.address).toBe("0xmarket002");
  });
});

