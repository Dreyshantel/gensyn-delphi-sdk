
import { describe, expect, it } from "vitest";

import {
  runMarketResearchPipeline,
} from "../../examples/evidence-starter/market-research-pipeline.js";

import {
  ruleBasedEvidenceAssessor,
} from "../../examples/evidence-starter/rule-based-assessor.js";

describe("research agent integration", () => {
  const now = Date.parse("2026-11-22T12:00:00.000Z");

  const marketAddress =
    "0x1234567890abcdef1234567890abcdef12345678";

  const marketQuestion =
    "Will Nigeria's annual inflation rate fall below 20 percent by December 2026?";

  const resolutionCriteria =
    "The official National Bureau of Statistics consumer price index report published by 31 December 2026 must confirm that annual inflation is below 20 percent.";

  const articleUrl =
    "https://example-news.test/nigeria-inflation-report";

  const articleContent = `
    Nigeria's National Bureau of Statistics published a consumer price index report
    covering the country's annual inflation rate.

    The report examined changes in consumer prices and inflation across Nigeria.
    Annual inflation remained a major economic indicator in the report.

    The published figures provide information that can be compared against the
    December 2026 inflation threshold of 20 percent.
  `;

  it("discovers a market, researches an article, assesses evidence and ranks findings", async () => {
    const result = await runMarketResearchPipeline({
      siteUrl: "https://competition.example",

      fetch: async () =>
        new Response(
          JSON.stringify({
            markets: [
              {
                address: marketAddress,
                question: marketQuestion,
                status: "open",
                odds: {
                  yes: 50,
                  no: 50,
                },
                evidenceCutoffAt: "2026-12-31T23:59:59.000Z",
                dataSources: [
                  "National Bureau of Statistics",
                  "Official economic reports",
                  "Government publications",
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),

      now,

      resolutionCriteriaByMarket: {
        [marketAddress]: resolutionCriteria,
      },

      maxMarketsToResearch: 3,

      researchOptions: {
        maxArticlesToFetch: 5,

        searchProvider: async () => [
          {
            title: "Nigeria inflation and consumer price index report",
            url: articleUrl,
            sourceName: "Example News",
            snippet:
              "National Bureau of Statistics report on Nigeria's annual inflation rate and consumer prices.",
            publishedAt: "2026-11-20T09:00:00.000Z",
          },
        ],

        articleFetcher: async (url) => ({
          requestedUrl: url,
          finalUrl: url,
          title: "Nigeria inflation and consumer price index report",
          content: articleContent,
          contentType: "text/html",
          fetchedAt: new Date(now).toISOString(),
        }),

        assessmentModel: ruleBasedEvidenceAssessor,
      },

      evidenceScoringPolicy: {
        sourceTypesByDomain: {
          "example-news.test": "news",
        },

        verifiabilityByUrl: {
          [articleUrl]: 0.8,
        },
      },
    });

    // 1. Market discovery and filtering
    expect(result.discoveredCount).toBe(1);
    expect(result.openCount).toBe(1);
    expect(result.rankedCount).toBe(1);

    // 2. The market must have been researched successfully.
    expect(result.researchedCount).toBe(1);
    expect(result.researches).toHaveLength(1);
    expect(result.researchFailures).toHaveLength(0);

    const marketResearch = result.researches[0];

    expect(marketResearch.market.address).toBe(marketAddress);

    // 3. The article must have been assessed.
    expect(
      marketResearch.research.assessments.length,
    ).toBeGreaterThan(0);

    const assessment =
      marketResearch.research.assessments[0];

    // The rule-based assessor cannot establish YES or NO,
    // so direction must be omitted rather than guessed.
    expect(assessment.assessment.direction).toBeUndefined();

    expect(
      assessment.assessment.relevanceScore,
    ).toBeGreaterThan(0);

    expect(
      assessment.assessment.supportingStatements.length,
    ).toBeGreaterThan(0);

    // 4. The pipeline must convert statements into findings
    // and rank the resulting evidence evaluations.
    expect(marketResearch.evaluations.length).toBeGreaterThan(0);

    const evaluation = marketResearch.evaluations[0];

    expect(evaluation.finding.marketAddress).toBe(marketAddress);

    expect(evaluation.finding.sourceUrl).toBe(articleUrl);

    expect(evaluation.finding.claim.length).toBeGreaterThan(0);

    expect(evaluation.scores.total).toBeGreaterThanOrEqual(0);

    expect(evaluation.scores.total).toBeLessThanOrEqual(1);

    expect([
      "strong",
      "review",
      "reject",
    ]).toContain(evaluation.recommendation);
  });
});

