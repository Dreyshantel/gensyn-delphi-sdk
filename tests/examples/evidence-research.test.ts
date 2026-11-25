
import { describe, expect, it } from "vitest";
import {
  buildEvidenceResearchOptions,
  calculateRecency,
  evaluateFinding,
  rankFindings,
  type EvidenceResearchOptions,
  type ResearchFinding,
} from "../../examples/evidence-starter/evidence-research.js";
import type { DiscoveredMarket } from "../../examples/evidence-starter/market-discovery.js";

const market: DiscoveredMarket = {
  address: "0xmarket001",
  question: "Will the company announce an IPO before December 2026?",
  status: "open",
  odds: { yes: 45, no: 55 },
  evidenceCutoffAt: "2026-12-01T00:00:00.000Z",
  dataSources: ["official website", "regulatory filings"],
};

const finding: ResearchFinding = {
  marketAddress: market.address,
  claim: "The company filed a confidential IPO registration statement.",
  sourceUrl: "https://example.com/ipo-filing",
  sourceName: "Example Financial News",
  sourceType: "news",
  publishedAt: "2026-11-19T10:00:00.000Z",
  discoveredAt: "2026-11-20T10:00:00.000Z",
  evidenceDate: "2026-11-19T10:00:00.000Z",
};

const options: EvidenceResearchOptions = {
  now: Date.parse("2026-11-20T12:00:00.000Z"),
  relevance: {
    [market.address]: 0.9,
  },
  credibility: {
    official: 1,
    regulatory: 1,
    academic: 0.9,
    news: 0.8,
    other: 0.4,
  },
  verifiability: {
    [finding.sourceUrl]: 0.9,
  },
};

const assessedFinding: ResearchFinding = {
  ...finding,
  relevanceAssessment: {
    score: 0.9,
    direction: "yes",
    rationale:
      "The claim directly supports the possibility of an IPO before the market deadline.",
  },
};

describe("evidence research evaluator", () => {
  describe("input validation", () => {
    it("rejects an empty claim", () => {
      expect(() =>
        evaluateFinding(
          { ...finding, claim: "   " },
          market,
          options,
        ),
      ).toThrow();
    });

    it("rejects an invalid source URL", () => {
      expect(() =>
        evaluateFinding(
          { ...finding, sourceUrl: "not-a-url" },
          market,
          options,
        ),
      ).toThrow();
    });

    it("rejects a non-HTTP source URL", () => {
      expect(() =>
        evaluateFinding(
          { ...finding, sourceUrl: "ftp://example.com/file" },
          market,
          options,
        ),
      ).toThrow();
    });

    it("rejects invalid publication dates", () => {
      expect(() =>
        evaluateFinding(
          { ...finding, publishedAt: "not-a-date" },
          market,
          options,
        ),
      ).toThrow();
    });

    it("rejects evidence dated after the market cutoff", () => {
      expect(() =>
        evaluateFinding(
          {
            ...finding,
            evidenceDate: "2026-12-02T10:00:00.000Z",
          },
          market,
          options,
        ),
      ).toThrow(/cutoff/i);
    });

    it("rejects evidence published in the future", () => {
      expect(() =>
        evaluateFinding(
          {
            ...finding,
            publishedAt: "2026-11-21T13:00:00.000Z",
          },
          market,
          options,
        ),
      ).toThrow(/future/i);
    });

    it("rejects a discovery date in the future", () => {
      expect(() =>
        evaluateFinding(
          {
            ...finding,
            discoveredAt: "2026-11-21T13:00:00.000Z",
          },
          market,
          options,
        ),
      ).toThrow(/future/i);
    });
  });

  describe("score validation", () => {
    it("rejects relevance scores above 1", () => {
      expect(() =>
        evaluateFinding(
          finding,
          market,
          {
            ...options,
            relevance: { [market.address]: 1.5 },
          },
        ),
      ).toThrow();
    });

    it("rejects credibility scores below 0", () => {
      expect(() =>
        evaluateFinding(
          finding,
          market,
          {
            ...options,
            credibility: {
              ...options.credibility,
              news: -0.2,
            },
          },
        ),
      ).toThrow();
    });

    it("rejects verifiability scores above 1", () => {
      expect(() =>
        evaluateFinding(
          finding,
          market,
          {
            ...options,
            verifiability: {
              [finding.sourceUrl]: 1.2,
            },
          },
        ),
      ).toThrow();
    });

    it("rejects relevance scores above 1 in a finding assessment", () => {
      expect(() =>
        evaluateFinding(
          {
            ...finding,
            relevanceAssessment: {
              score: 1.5,
              direction: "yes",
              rationale:
                "The claim directly supports the market outcome.",
            },
          },
          market,
          options,
        ),
      ).toThrow();
    });

    it("rejects an invalid evidence direction", () => {
      expect(() =>
        evaluateFinding(
          {
            ...finding,
            relevanceAssessment: {
              score: 0.9,
              direction: "maybe" as "yes",
              rationale: "The claim appears relevant.",
            },
          },
          market,
          options,
        ),
      ).toThrow();
    });

    it("rejects an empty relevance rationale", () => {
      expect(() =>
        evaluateFinding(
          {
            ...finding,
            relevanceAssessment: {
              score: 0.9,
              direction: "yes",
              rationale: "   ",
            },
          },
          market,
          options,
        ),
      ).toThrow();
    });
  });

  describe("recency", () => {
    it("gives newer evidence a higher recency score", () => {
      const now = Date.parse("2026-11-20T12:00:00.000Z");

      const recentScore = calculateRecency(
        "2026-11-19T12:00:00.000Z",
        now,
      );

      const oldScore = calculateRecency(
        "2026-06-01T12:00:00.000Z",
        now,
      );

      expect(recentScore).toBeGreaterThan(oldScore);
    });

    it("returns a score between 0 and 1", () => {
      const score = calculateRecency(
        "2026-11-19T12:00:00.000Z",
        Date.parse("2026-11-20T12:00:00.000Z"),
      );

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("rejects invalid publication dates", () => {
      expect(() =>
        calculateRecency(
          "not-a-date",
          Date.parse("2026-11-20T12:00:00.000Z"),
        ),
      ).toThrow(/date/i);
    });

    it("rejects publication dates in the future", () => {
      expect(() =>
        calculateRecency(
          "2026-11-21T12:00:00.000Z",
          Date.parse("2026-11-20T12:00:00.000Z"),
        ),
      ).toThrow(/future/i);
    });
  });

  describe("duplicate detection", () => {
    it("marks a previously known claim as a duplicate", () => {
      const result = evaluateFinding(finding, market, {
        ...options,
        knownClaims: [
          {
            claim:
              "The company filed a confidential IPO registration statement.",
            marketAddress: market.address,
          },
        ],
      });

      expect(result.duplicate).toBe(true);
      expect(result.scores.novelty).toBe(0);
      expect(result.recommendation).toBe("reject");
    });

    it("normalises basic punctuation and letter case when checking duplicates", () => {
      const result = evaluateFinding(finding, market, {
        ...options,
        knownClaims: [
          {
            claim:
              "THE COMPANY FILED A CONFIDENTIAL IPO REGISTRATION STATEMENT!",
            marketAddress: market.address,
          },
        ],
      });

      expect(result.duplicate).toBe(true);
    });
  });

  describe("market matching", () => {
    it("rejects findings associated with another market", () => {
      expect(() =>
        evaluateFinding(
          { ...finding, marketAddress: "0xdifferentmarket" },
          market,
          options,
        ),
      ).toThrow();
    });

    it("accepts a market address that differs only by letter casing", () => {
      expect(() =>
        evaluateFinding(
          {
            ...finding,
            marketAddress: market.address.toUpperCase(),
          },
          market,
          options,
        ),
      ).not.toThrow();
    });

    it("uses the market-level relevance fallback case-insensitively", () => {
      const result = evaluateFinding(
        {
          ...finding,
          marketAddress: market.address.toUpperCase(),
        },
        market,
        options,
      );

      expect(result.scores.relevance).toBe(0.9);
    });
  });

  describe("finding evaluation and ranking", () => {
    it("returns scores and a recommendation", () => {
      const result = evaluateFinding(finding, market, options);

      expect(result.scores.total).toBeGreaterThan(0);
      expect(result.scores.total).toBeLessThanOrEqual(1);
      expect(["strong", "review", "reject"]).toContain(
        result.recommendation,
      );
    });

    it("uses finding-level relevance instead of market-level relevance", () => {
      const result = evaluateFinding(
        {
          ...finding,
          relevanceAssessment: {
            score: 0.2,
            direction: "yes",
            rationale:
              "The claim provides limited support for the IPO outcome.",
          },
        },
        market,
        options,
      );

      expect(result.scores.relevance).toBe(0.2);
      expect(result.relevanceAssessment?.direction).toBe("yes");
    });

    it("accepts evidence that supports the NO outcome", () => {
      const result = evaluateFinding(
        {
          ...finding,
          relevanceAssessment: {
            score: 0.85,
            direction: "no",
            rationale:
              "The filing was withdrawn before the stated deadline.",
          },
        },
        market,
        options,
      );

      expect(result.relevanceAssessment?.direction).toBe("no");
      expect(result.scores.relevance).toBe(0.85);
    });

    it("recommends strong when all strong-evidence conditions are met", () => {
      const result = evaluateFinding(
        assessedFinding,
        market,
        options,
      );

      expect(result.scores.relevance).toBeGreaterThanOrEqual(0.5);
      expect(result.scores.credibility).toBeGreaterThanOrEqual(0.5);
      expect(result.scores.verifiability).toBeGreaterThanOrEqual(0.5);
      expect(result.scores.novelty).toBeGreaterThanOrEqual(0.5);
      expect(result.scores.total).toBeGreaterThanOrEqual(0.75);
      expect(result.recommendation).toBe("strong");
    });

    it("keeps an otherwise strong finding under review when verifiability is below 0.5", () => {
      const result = evaluateFinding(
        assessedFinding,
        market,
        {
          ...options,
          verifiability: {},
        },
      );

      expect(result.scores.relevance).toBeGreaterThanOrEqual(0.5);
      expect(result.scores.credibility).toBeGreaterThanOrEqual(0.5);
      expect(result.scores.verifiability).toBeLessThan(0.5);
      expect(result.recommendation).toBe("review");
    });

    it("rejects a finding with relevance below 0.3", () => {
      const result = evaluateFinding(
        {
          ...assessedFinding,
          relevanceAssessment: {
            score: 0.29,
            direction: "yes",
            rationale: "The claim has very weak relevance.",
          },
        },
        market,
        options,
      );

      expect(result.recommendation).toBe("reject");
    });

    it("rejects a finding with credibility below 0.3", () => {
      const result = evaluateFinding(
        assessedFinding,
        market,
        {
          ...options,
          credibility: {
            ...options.credibility,
            news: 0.29,
          },
        },
      );

      expect(result.recommendation).toBe("reject");
    });

    it("keeps a finding under review when it has no explicit relevance assessment", () => {
      const result = evaluateFinding(finding, market, options);

      expect(result.relevanceAssessment).toBeUndefined();
      expect(result.recommendation).toBe("review");
      expect(result.reasons).toContain(
        "Finding has not received an explicit relevance assessment",
      );
    });

    it("ranks higher-scoring findings first", () => {
      const weakerFinding: ResearchFinding = {
        ...finding,
        claim: "An unconfirmed rumour about a possible IPO.",
        sourceUrl: "https://example.com/rumour",
        sourceName: "Unknown Blog",
        sourceType: "other",
      };

      const results = rankFindings(
        [weakerFinding, finding],
        market,
        {
          ...options,
          verifiability: {
            [finding.sourceUrl]: 0.9,
            [weakerFinding.sourceUrl]: 0.2,
          },
        },
      );

      expect(results[0].finding.claim).toBe(finding.claim);
      expect(results[0].scores.total).toBeGreaterThan(
        results[1].scores.total,
      );
    });
  });

  describe("ranking options", () => {
    it("supplies market relevance, credibility, and URL verifiability", () => {
      const secondFinding: ResearchFinding = {
        ...finding,
        claim: "A second public filing was posted the same day.",
        sourceUrl: "https://example.com/second-filing",
      };

      const built = buildEvidenceResearchOptions({
        marketAddress: market.address,
        findings: [finding, secondFinding],
        credibility: options.credibility,
        getVerifiability: (sourceUrl) =>
          sourceUrl === secondFinding.sourceUrl ? 0.2 : 0.9,
        now: options.now,
        knownClaims: [
          {
            claim: "Already recorded",
            marketAddress: market.address,
          },
        ],
      });

      expect(built.relevance).toEqual({
        [market.address]: 0,
      });
      expect(built.credibility).toBe(options.credibility);
      expect(built.verifiability).toEqual({
        [finding.sourceUrl]: 0.9,
        [secondFinding.sourceUrl]: 0.2,
      });
      expect(built.now).toBe(options.now);
      expect(built.knownClaims).toEqual([
        {
          claim: "Already recorded",
          marketAddress: market.address,
        },
      ]);
    });

    it("lets a finding assessment override the market relevance fallback", () => {
      const diagnosticMarket = {
        ...market,
        address: "LIVE-RESEARCH-DIAGNOSTIC",
      };
      const diagnosticFinding: ResearchFinding = {
        ...assessedFinding,
        marketAddress: diagnosticMarket.address,
        relevanceAssessment: {
          score: 0.62,
          rationale:
            "The statement is about the market subject but does not settle it.",
        },
      };

      const built = buildEvidenceResearchOptions({
        marketAddress: diagnosticMarket.address,
        findings: [diagnosticFinding],
        credibility: options.credibility,
        getVerifiability: () => 0.35,
        now: options.now,
      });

      const [result] = rankFindings(
        [diagnosticFinding],
        diagnosticMarket,
        built,
      );

      expect(built.relevance[diagnosticMarket.address]).toBe(0);
      expect(result.scores.relevance).toBe(0.62);
      expect(result.scores.credibility).toBe(options.credibility.news);
      expect(result.scores.verifiability).toBe(0.35);
      expect(result.scores.total).toEqual(expect.any(Number));
      expect(result.recommendation).toBe("review");
      expect(result.relevanceAssessment?.direction).toBeUndefined();
    });

    it("ranks a finding that has no relevance assessment", () => {
      const built = buildEvidenceResearchOptions({
        marketAddress: market.address,
        findings: [finding],
        credibility: options.credibility,
        getVerifiability: () => 0.35,
        now: options.now,
      });

      const [result] = rankFindings([finding], market, built);

      expect(result.relevanceAssessment).toBeUndefined();
      expect(result.finding.relevanceAssessment).toBeUndefined();
      expect(result.scores.relevance).toBe(0);
      expect(result.scores.total).toEqual(expect.any(Number));
      expect(result.recommendation).toBe("reject");
      expect(Array.isArray(result.reasons)).toBe(true);
    });

    it("rejects a blank market address", () => {
      expect(() =>
        buildEvidenceResearchOptions({
          marketAddress: "   ",
          findings: [],
          credibility: options.credibility,
          getVerifiability: () => 0,
        }),
      ).toThrow("Market address is required");
    });
  });
});

