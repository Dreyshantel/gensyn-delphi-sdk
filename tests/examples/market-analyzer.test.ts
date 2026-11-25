
import { describe, expect, it } from "vitest";

import {
  analyseMarket,
  calculateUncertainty,
  normaliseProbability,
  rankMarkets,
} from "../../examples/evidence-starter/market-analyzer.js";

import type { DiscoveredMarket } from "../../examples/evidence-starter/market-discovery.js";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function createMarket(
  overrides: Partial<DiscoveredMarket> = {},
): DiscoveredMarket {
  return {
    address: "0xAbCd",
    question: "Will the Central Bank increase interest rates?",
    status: "open",
    odds: {
      yes: 50,
      no: 50,
    },
    evidenceCutoffAt: "2026-12-01T23:59:59.000Z",
    dataSources: ["https://example.com/source-1"],
    ...overrides,
  };
}

describe("market analyser", () => {
  describe("normaliseProbability", () => {
    it("normalises fractional probabilities", () => {
      expect(normaliseProbability(0.25)).toBe(0.25);
      expect(normaliseProbability(0.5)).toBe(0.5);
      expect(normaliseProbability(1)).toBe(1);
    });

    it("normalises percentage probabilities", () => {
      expect(normaliseProbability(25)).toBe(0.25);
      expect(normaliseProbability(50)).toBe(0.5);
      expect(normaliseProbability(75)).toBe(0.75);
      expect(normaliseProbability(100)).toBe(1);
    });

    it("rejects probabilities above 100 percent", () => {
      expect(() => normaliseProbability(101)).toThrow();
    });

    it("rejects negative probabilities", () => {
      expect(() => normaliseProbability(-0.1)).toThrow();
    });

    it("rejects NaN probabilities", () => {
      expect(() => normaliseProbability(Number.NaN)).toThrow();
    });

    it("rejects infinite probabilities", () => {
      expect(() => normaliseProbability(Infinity)).toThrow();
      expect(() => normaliseProbability(-Infinity)).toThrow();
    });
  });

  describe("calculateUncertainty", () => {
    it("assigns maximum uncertainty to a 50 percent probability", () => {
      expect(calculateUncertainty(0.5)).toBe(1);
    });

    it("assigns zero uncertainty to a certain outcome", () => {
      expect(calculateUncertainty(0)).toBe(0);
      expect(calculateUncertainty(1)).toBe(0);
    });

    it("calculates uncertainty for an intermediate probability", () => {
      expect(calculateUncertainty(0.25)).toBeCloseTo(0.811278, 5);
    });

    it("produces symmetrical uncertainty for complementary probabilities", () => {
      expect(calculateUncertainty(0.2)).toBeCloseTo(
        calculateUncertainty(0.8),
      );
    });

    it("rejects probabilities below zero", () => {
      expect(() => calculateUncertainty(-0.1)).toThrow();
    });

    it("rejects probabilities above one", () => {
      expect(() => calculateUncertainty(1.1)).toThrow();
    });

    it("rejects NaN probabilities", () => {
      expect(() => calculateUncertainty(Number.NaN)).toThrow();
    });

    it("rejects positive and negative infinity", () => {
      expect(() => calculateUncertainty(Infinity)).toThrow();
      expect(() => calculateUncertainty(-Infinity)).toThrow();
    });
  });

  describe("analyseMarket", () => {
    it("analyses a valid market", () => {
      const result = analyseMarket(createMarket(), { now: NOW });

      expect(result.market.question).toBe(
        "Will the Central Bank increase interest rates?",
      );
      expect(result.yesProbability).toBe(0.5);
      expect(result.uncertainty).toBe(1);
      expect(result.timeRemainingMs).toBeGreaterThan(0);
      expect(result.suggestedSourceCoverage).toBeCloseTo(1 / 3);
      expect(result.researchability).toBeCloseTo(1 / 3);
      expect(result.timeFactor).toBe(1);
      expect(result.priorityScore).toBeGreaterThan(0);
      expect(["high", "medium", "low"]).toContain(result.priority);
    });

    it("normalises percentage odds during market analysis", () => {
      const result = analyseMarket(
        createMarket({
          odds: { yes: 75, no: 25 },
        }),
        { now: NOW },
      );

      expect(result.yesProbability).toBe(0.75);
    });

    it("normalises fractional odds during market analysis", () => {
      const result = analyseMarket(
        createMarket({
          odds: { yes: 0.75, no: 0.25 },
        }),
        { now: NOW },
      );

      expect(result.yesProbability).toBe(0.75);
    });

    it("calculates remaining time before the evidence cutoff", () => {
      const cutoff = Date.parse("2026-11-22T12:00:00.000Z");

      const result = analyseMarket(
        createMarket({
          evidenceCutoffAt: "2026-11-22T12:00:00.000Z",
        }),
        { now: NOW },
      );

      expect(result.timeRemainingMs).toBe(cutoff - NOW);
    });

    it("returns zero remaining time after the evidence cutoff", () => {
      const result = analyseMarket(
        createMarket({
          evidenceCutoffAt: "2026-11-20T12:00:00.000Z",
        }),
        { now: NOW },
      );

      expect(result.timeRemainingMs).toBe(0);
      expect(result.timeFactor).toBe(0);
    });

    it("uses the maximum time factor when at least 24 hours remain", () => {
      const result = analyseMarket(
        createMarket({
          evidenceCutoffAt: "2026-11-23T12:00:00.000Z",
        }),
        { now: NOW },
      );

      expect(result.timeFactor).toBe(1);
    });

    it("calculates a partial time factor when less than 24 hours remain", () => {
      const result = analyseMarket(
        createMarket({
          evidenceCutoffAt: "2026-11-22T00:00:00.000Z",
        }),
        { now: NOW },
      );

      expect(result.timeFactor).toBe(0.5);
    });

    it("rejects an invalid evidence cutoff date", () => {
      expect(() =>
        analyseMarket(
          createMarket({
            evidenceCutoffAt: "not-a-valid-date",
          }),
          { now: NOW },
        ),
      ).toThrow();
    });

    it("rejects a non-finite analysis timestamp", () => {
      expect(() =>
        analyseMarket(createMarket(), { now: Number.NaN }),
      ).toThrow();

      expect(() =>
        analyseMarket(createMarket(), { now: Infinity }),
      ).toThrow();
    });

    it("assigns zero suggested source coverage when no sources exist", () => {
      const result = analyseMarket(
        createMarket({ dataSources: [] }),
        { now: NOW },
      );

      expect(result.suggestedSourceCoverage).toBe(0);
      expect(result.researchability).toBe(0);
    });

    it("calculates partial suggested source coverage", () => {
      const result = analyseMarket(
        createMarket({
          dataSources: [
            "https://example.com/source-1",
            "https://example.com/source-2",
          ],
        }),
        { now: NOW },
      );

      expect(result.suggestedSourceCoverage).toBeCloseTo(2 / 3);
      expect(result.researchability).toBeCloseTo(2 / 3);
    });

    it("caps suggested source coverage at one", () => {
      const result = analyseMarket(
        createMarket({
          dataSources: [
            "https://example.com/source-1",
            "https://example.com/source-2",
            "https://example.com/source-3",
            "https://example.com/source-4",
          ],
        }),
        { now: NOW },
      );

      expect(result.suggestedSourceCoverage).toBe(1);
      expect(result.researchability).toBe(1);
    });

    it("uses supplied researchability instead of suggested source coverage", () => {
      const result = analyseMarket(createMarket(), {
        now: NOW,
        researchability: {
          "0xAbCd": 0.8,
        },
      });

      expect(result.suggestedSourceCoverage).toBeCloseTo(1 / 3);
      expect(result.researchability).toBe(0.8);
    });

    it("uses supplied researchability with a case-insensitive address", () => {
      const result = analyseMarket(createMarket(), {
        now: NOW,
        researchability: {
          "0xabcd": 0.9,
        },
      });

      expect(result.researchability).toBe(0.9);
    });

    it("supports zero researchability", () => {
      const result = analyseMarket(createMarket(), {
        now: NOW,
        researchability: {
          "0xAbCd": 0,
        },
      });

      expect(result.researchability).toBe(0);
    });

    it("supports maximum researchability", () => {
      const result = analyseMarket(createMarket(), {
        now: NOW,
        researchability: {
          "0xAbCd": 1,
        },
      });

      expect(result.researchability).toBe(1);
    });

    it("rejects NaN researchability scores", () => {
      expect(() =>
        analyseMarket(createMarket(), {
          now: NOW,
          researchability: {
            "0xAbCd": Number.NaN,
          },
        }),
      ).toThrow();
    });

    it("rejects infinite researchability scores", () => {
      expect(() =>
        analyseMarket(createMarket(), {
          now: NOW,
          researchability: {
            "0xAbCd": Infinity,
          },
        }),
      ).toThrow();
    });

    it("rejects negative researchability scores", () => {
      expect(() =>
        analyseMarket(createMarket(), {
          now: NOW,
          researchability: {
            "0xAbCd": -0.1,
          },
        }),
      ).toThrow();
    });

    it("rejects researchability scores greater than one", () => {
      expect(() =>
        analyseMarket(createMarket(), {
          now: NOW,
          researchability: {
            "0xAbCd": 1.1,
          },
        }),
      ).toThrow();
    });

    it("calculates the priority score using the configured weights", () => {
      const result = analyseMarket(
        createMarket({
          odds: { yes: 50, no: 50 },
          dataSources: [
            "https://example.com/source-1",
            "https://example.com/source-2",
            "https://example.com/source-3",
          ],
          evidenceCutoffAt: "2026-11-23T12:00:00.000Z",
        }),
        {
          now: NOW,
          researchability: {
            "0xAbCd": 0.8,
          },
        },
      );

      // (uncertainty * 0.35 + researchability * 0.45 + timeFactor * 0.20) * 100
      // (1 * 0.35 + 0.8 * 0.45 + 1 * 0.20) * 100 = 91
      expect(result.priorityScore).toBeCloseTo(91);
    });

    it("assigns high priority to scores of 70 or above", () => {
      const result = analyseMarket(createMarket(), {
        now: NOW,
        researchability: {
          "0xAbCd": 1,
        },
      });

      expect(result.priorityScore).toBeGreaterThanOrEqual(70);
      expect(result.priority).toBe("high");
    });

    it("assigns medium priority to scores between 40 and 70", () => {
      const result = analyseMarket(
        createMarket({
          odds: { yes: 50, no: 50 },
          evidenceCutoffAt: "2026-11-20T12:00:00.000Z",
        }),
        {
          now: NOW,
          researchability: {
            "0xAbCd": 0.5,
          },
        },
      );

      expect(result.priorityScore).toBeCloseTo(57.5);
      expect(result.priority).toBe("medium");
    });

    it("assigns low priority to scores below 40", () => {
      const result = analyseMarket(
        createMarket({
          odds: { yes: 0, no: 100 },
          evidenceCutoffAt: "2026-11-20T12:00:00.000Z",
        }),
        {
          now: NOW,
          researchability: {
            "0xAbCd": 0,
          },
        },
      );

      expect(result.priorityScore).toBe(0);
      expect(result.priority).toBe("low");
    });
  });

  describe("rankMarkets", () => {
    it("ranks markets from highest to lowest priority", () => {
      const highPriorityMarket = createMarket({
        address: "0xhigh",
        odds: { yes: 50, no: 50 },
        dataSources: [
          "https://example.com/source-1",
          "https://example.com/source-2",
          "https://example.com/source-3",
        ],
      });

      const lowPriorityMarket = createMarket({
        address: "0xlow",
        odds: { yes: 0, no: 100 },
        dataSources: [],
      });

      const result = rankMarkets(
        [lowPriorityMarket, highPriorityMarket],
        { now: NOW },
      );

      expect(result).toHaveLength(2);
      expect(result[0].market.address).toBe("0xhigh");
      expect(result[1].market.address).toBe("0xlow");
    });

    it("returns an empty array when no markets are supplied", () => {
      expect(rankMarkets([], { now: NOW })).toEqual([]);
    });

    it("uses supplied researchability scores when ranking markets", () => {
      const marketA = createMarket({
        address: "0xmarketA",
        odds: { yes: 50, no: 50 },
      });

      const marketB = createMarket({
        address: "0xmarketB",
        odds: { yes: 50, no: 50 },
      });

      const result = rankMarkets([marketA, marketB], {
        now: NOW,
        researchability: {
          "0xmarketA": 0.2,
          "0xmarketB": 0.9,
        },
      });

      expect(result[0].market.address).toBe("0xmarketB");
      expect(result[1].market.address).toBe("0xmarketA");
    });
  });
});

