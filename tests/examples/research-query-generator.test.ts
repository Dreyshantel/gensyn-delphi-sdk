
import { describe, expect, it } from "vitest";

import {
  ruleBasedResearchQueryGenerator,
} from "../../examples/evidence-starter/research-query-generator.js";

import type {
  ResearchPlanningInput,
} from "../../examples/evidence-starter/research-planner.js";

const sampleInput: ResearchPlanningInput = {
  marketAddress: "0x1234567890abcdef",
  marketQuestion: "Will Nigeria introduce a new digital banking policy?",
  resolutionCriteria:
    "The market resolves YES if the Nigerian government officially announces the policy before the deadline.",
  evidenceCutoffAt: "2026-12-01T23:59:59Z",
  suggestedDataSources: [
    "Central Bank of Nigeria",
    "Federal Ministry of Finance",
    "Reuters",
  ],
};

describe("rule-based research query generator", () => {
  it("generates a research plan with at least three queries", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    expect(result).toHaveProperty("queries");
    expect(result.queries.length).toBeGreaterThanOrEqual(3);
  });

  it("generates no more than eight queries", async () => {
    const result = await ruleBasedResearchQueryGenerator({
      ...sampleInput,
      suggestedDataSources: [
        "Source A",
        "Source B",
        "Source C",
        "Source D",
        "Source E",
      ],
    });

    expect(result.queries.length).toBeLessThanOrEqual(8);
  });

  it("includes the market question in the general research queries", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    expect(
      result.queries.some((item) =>
        item.query.includes(sampleInput.marketQuestion),
      ),
    ).toBe(true);
  });

  it("generates an official-source research query", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    expect(
      result.queries.some((item) =>
        item.sourceTypes.includes("official"),
      ),
    ).toBe(true);
  });

  it("generates a regulatory research query when appropriate", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    expect(
      result.queries.some((item) =>
        item.sourceTypes.includes("regulatory"),
      ),
    ).toBe(true);
  });

  it("generates a news research query", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    expect(
      result.queries.some((item) =>
        item.sourceTypes.includes("news"),
      ),
    ).toBe(true);
  });

  it("uses suggested data sources to create additional queries", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    expect(
      result.queries.some((item) =>
        item.query.includes("Central Bank of Nigeria"),
      ),
    ).toBe(true);
  });

  it("classifies suggested sources using their names", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    const cnbQuery = result.queries.find((item) =>
      item.query.includes("Central Bank of Nigeria"),
    );

    const reutersQuery = result.queries.find((item) =>
      item.query.includes("Reuters"),
    );

    expect(cnbQuery?.sourceTypes).toContain("regulatory");
    expect(reutersQuery?.sourceTypes).toContain("news");
  });

  it("provides an objective for every research query", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    for (const query of result.queries) {
      expect(query.objective.trim().length).toBeGreaterThan(0);
    }
  });

  it("does not generate duplicate queries", async () => {
    const result = await ruleBasedResearchQueryGenerator({
      ...sampleInput,
      suggestedDataSources: [
        "Reuters",
        "reuters",
        "Reuters",
      ],
    });

    const normalised = result.queries.map((item) =>
      item.query.toLowerCase().replace(/\s+/g, " ").trim(),
    );

    expect(new Set(normalised).size).toBe(normalised.length);
  });

  it("limits suggested-source queries to three", async () => {
    const result = await ruleBasedResearchQueryGenerator({
      ...sampleInput,
      suggestedDataSources: [
        "Source A",
        "Source B",
        "Source C",
        "Source D",
        "Source E",
      ],
    });

    const suggestedSourceQueries = result.queries.filter((item) =>
      ["Source A", "Source B", "Source C", "Source D", "Source E"]
        .some((source) => item.query.includes(source)),
    );

    expect(suggestedSourceQueries.length).toBeLessThanOrEqual(3);
  });

  it("adds explicit Nigerian geographic context to generated queries", async () => {
    const result = await ruleBasedResearchQueryGenerator(sampleInput);

    expect(
      result.queries.every((item) =>
        item.query.toLowerCase().includes("nigeria"),
      ),
    ).toBe(true);
  });

  it("detects geographic context from the resolution criteria", async () => {
    const result = await ruleBasedResearchQueryGenerator({
      ...sampleInput,
      marketQuestion: "Will annual inflation fall below 10 percent?",
      resolutionCriteria:
        "The official Ghana Statistical Service report must confirm the annual inflation rate.",
    });

    expect(
      result.queries.every((item) =>
        item.query.includes('"Ghana"'),
      ),
    ).toBe(true);
  });

  it("supports markets about countries other than Nigeria", async () => {
    const result = await ruleBasedResearchQueryGenerator({
      ...sampleInput,
      marketQuestion: "Will Canada's inflation rate fall below 2 percent?",
      resolutionCriteria:
        "The official Statistics Canada report must confirm the inflation rate.",
      suggestedDataSources: [
        "Statistics Canada",
        "Bank of Canada",
        "Canadian government publications",
      ],
    });

    expect(
      result.queries.every((item) =>
        item.query.includes('"Canada"'),
      ),
    ).toBe(true);

    expect(
      result.queries.some((item) =>
        item.query.toLowerCase().includes("nigeria"),
      ),
    ).toBe(false);
  });

  it("does not invent geographic context when none is identified", async () => {
    const result = await ruleBasedResearchQueryGenerator({
      ...sampleInput,
      marketQuestion: "Will a new international technology standard be adopted?",
      resolutionCriteria:
        "The market resolves YES if the standards organisation formally adopts the proposal.",
      suggestedDataSources: ["Official standards organisation"],
    });

    expect(
      result.queries.every((item) =>
        !item.query.includes('"Nigeria"'),
      ),
    ).toBe(true);
  });

  it("classifies statistical bureaus as official sources", async () => {
    const result = await ruleBasedResearchQueryGenerator({
      ...sampleInput,
      suggestedDataSources: ["National Bureau of Statistics"],
    });

    const bureauQuery = result.queries.find((item) =>
      item.query.includes("National Bureau of Statistics"),
    );

    expect(bureauQuery?.sourceTypes).toContain("official");
  });
});

