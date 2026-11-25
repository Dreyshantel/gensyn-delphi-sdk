
import { describe, expect, it, vi } from "vitest";

import {
  planResearchQueries,
  type ResearchPlanningInput,
} from "../../examples/evidence-starter/research-planner.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");

const validInput: ResearchPlanningInput = {
  marketAddress: "0x123456789",
  marketQuestion: "Will Company X announce an IPO before December 2026?",
  resolutionCriteria:
    "Resolves YES if Company X officially announces an IPO before December 2026.",
  evidenceCutoffAt: "2026-12-01T00:00:00Z",
  suggestedDataSources: [
    "Company announcements",
    "Regulatory filings",
    "Financial news",
  ],
};

const validQueries = {
  queries: [
    {
      query: "Company X official IPO announcement",
      objective: "Find an official announcement confirming an IPO.",
      sourceTypes: ["official"],
    },
    {
      query: "Company X IPO regulatory filings",
      objective: "Find regulatory documentation relating to an IPO.",
      sourceTypes: ["regulatory"],
    },
    {
      query: "Company X IPO preparations financial news",
      objective: "Find independent reporting about IPO preparations.",
      sourceTypes: ["news"],
    },
  ],
};

describe("research planner", () => {
  it("generates a valid research plan", async () => {
    const generator = vi.fn().mockResolvedValue(validQueries);

    const result = await planResearchQueries(
      validInput,
      generator,
      NOW,
    );

    expect(result.marketAddress).toBe(validInput.marketAddress);
    expect(result.queries).toHaveLength(3);
    expect(result.queries[0].sourceTypes).toEqual(["official"]);
  });

  it("passes market information to the query generator", async () => {
    const generator = vi.fn().mockResolvedValue(validQueries);

    await planResearchQueries(validInput, generator, NOW);

    expect(generator).toHaveBeenCalledWith(validInput);
    expect(generator).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty market address", async () => {
    const generator = vi.fn();

    await expect(
      planResearchQueries(
        { ...validInput, marketAddress: " " },
        generator,
        NOW,
      ),
    ).rejects.toThrow("marketAddress cannot be empty");

    expect(generator).not.toHaveBeenCalled();
  });

  it("rejects an empty market question", async () => {
    await expect(
      planResearchQueries(
        { ...validInput, marketQuestion: "" },
        vi.fn(),
        NOW,
      ),
    ).rejects.toThrow("marketQuestion cannot be empty");
  });

  it("rejects missing resolution criteria", async () => {
    await expect(
      planResearchQueries(
        { ...validInput, resolutionCriteria: " " },
        vi.fn(),
        NOW,
      ),
    ).rejects.toThrow("resolutionCriteria cannot be empty");
  });

  it("rejects an invalid evidence cutoff", async () => {
    await expect(
      planResearchQueries(
        { ...validInput, evidenceCutoffAt: "invalid-date" },
        vi.fn(),
        NOW,
      ),
    ).rejects.toThrow("Invalid evidence cutoff date");
  });

  it("rejects a market whose evidence cutoff has passed", async () => {
    await expect(
      planResearchQueries(
        { ...validInput, evidenceCutoffAt: "2026-11-19T00:00:00Z" },
        vi.fn(),
        NOW,
      ),
    ).rejects.toThrow("Market evidence cutoff has passed");
  });

  it("rejects invalid suggested data sources", async () => {
    await expect(
      planResearchQueries(
        {
          ...validInput,
          suggestedDataSources: ["Company announcements", ""],
        },
        vi.fn(),
        NOW,
      ),
    ).rejects.toThrow("Suggested data sources must be non-empty strings");
  });

  it("rejects a response that is not a research plan", async () => {
    const generator = vi.fn().mockResolvedValue("invalid response");

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("Research plan must contain a queries array");
  });

  it("rejects fewer than three queries", async () => {
    const generator = vi.fn().mockResolvedValue({
      queries: validQueries.queries.slice(0, 2),
    });

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("between 3 and 8 queries");
  });

  it("rejects more than eight queries", async () => {
    const generator = vi.fn().mockResolvedValue({
      queries: Array.from({ length: 9 }, (_, index) => ({
        query: `Unique research query ${index}`,
        objective: "Investigate the market.",
        sourceTypes: ["news"],
      })),
    });

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("between 3 and 8 queries");
  });

  it("rejects empty queries", async () => {
    const generator = vi.fn().mockResolvedValue({
      queries: [
        { query: "", objective: "Find official evidence.", sourceTypes: ["official"] },
        ...validQueries.queries.slice(1),
      ],
    });

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("has an empty query");
  });

  it("rejects empty research objectives", async () => {
    const generator = vi.fn().mockResolvedValue({
      queries: [
        { ...validQueries.queries[0], objective: "" },
        ...validQueries.queries.slice(1),
      ],
    });

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("has an empty objective");
  });

  it("rejects invalid source categories", async () => {
    const generator = vi.fn().mockResolvedValue({
      queries: [
        { ...validQueries.queries[0], sourceTypes: ["social-media"] },
        ...validQueries.queries.slice(1),
      ],
    });

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("has invalid source types");
  });

  it("rejects queries with no source categories", async () => {
    const generator = vi.fn().mockResolvedValue({
      queries: [
        { ...validQueries.queries[0], sourceTypes: [] },
        ...validQueries.queries.slice(1),
      ],
    });

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("has invalid source types");
  });

  it("rejects duplicate queries even when casing differs", async () => {
    const generator = vi.fn().mockResolvedValue({
      queries: [
        validQueries.queries[0],
        {
          ...validQueries.queries[1],
          query: "COMPANY X OFFICIAL IPO ANNOUNCEMENT",
        },
        validQueries.queries[2],
      ],
    });

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("duplicate queries");
  });

  it("removes duplicate source categories from a valid query", async () => {
    const generator = vi.fn().mockResolvedValue({
      queries: [
        { ...validQueries.queries[0], sourceTypes: ["official", "official"] },
        ...validQueries.queries.slice(1),
      ],
    });

    const result = await planResearchQueries(
      validInput,
      generator,
      NOW,
    );

    expect(result.queries[0].sourceTypes).toEqual(["official"]);
  });

  it("propagates errors from the query generator", async () => {
    const generator = vi.fn().mockRejectedValue(
      new Error("Model service unavailable"),
    );

    await expect(
      planResearchQueries(validInput, generator, NOW),
    ).rejects.toThrow("Model service unavailable");
  });
});

