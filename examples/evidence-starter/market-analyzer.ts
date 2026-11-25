
import type { DiscoveredMarket } from "./market-discovery.js";

export interface MarketAnalysis {
  market: DiscoveredMarket;
  yesProbability: number;
  uncertainty: number;
  timeRemainingMs: number;
  suggestedSourceCoverage: number;
  researchability: number;
  timeFactor: number;
  priorityScore: number;
  priority: "high" | "medium" | "low";
}

export interface AnalysisOptions {
  now?: number;
  researchability?: Record<string, number>;
}

/**
 * Normalises odds represented as either fractions or percentages.
 */
export function normaliseProbability(value: number): number {
  const probability = value > 1 ? value / 100 : value;

  if (
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    throw new Error(`Invalid probability: ${value}`);
  }

  return probability;
}

/**
 * Measures uncertainty using binary entropy.
 *
 * Values near 0.5 have greater uncertainty.
 * Values near 0 or 1 have lower uncertainty.
 */
export function calculateUncertainty(probability: number): number {
  if (
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  ) {
    throw new Error(
      "Probability must be a finite number between 0 and 1",
    );
  }

  if (probability === 0 || probability === 1) {
    return 0;
  }

  return -(
    probability * Math.log2(probability) +
    (1 - probability) * Math.log2(1 - probability)
  );
}

/**
 * Finds a supplied researchability score using a
 * case-insensitive market address comparison.
 */
function getResearchability(
  marketAddress: string,
  scores: Record<string, number> | undefined,
): number | undefined {
  if (!scores) {
    return undefined;
  }

  const normalizedAddress = marketAddress.toLowerCase();

  const matchingEntry = Object.entries(scores).find(
    ([address]) => address.toLowerCase() === normalizedAddress,
  );

  return matchingEntry?.[1];
}

/**
 * Produces a research priority score.
 *
 * This is an initial heuristic, not a prediction of Delphi rewards.
 */
export function analyseMarket(
  market: DiscoveredMarket,
  options: AnalysisOptions = {},
): MarketAnalysis {
  const now = options.now ?? Date.now();

  if (!Number.isFinite(now)) {
    throw new Error(`Invalid analysis timestamp: ${now}`);
  }

  const yesProbability = normaliseProbability(market.odds.yes);
  const uncertainty = calculateUncertainty(yesProbability);

  const cutoff = Date.parse(market.evidenceCutoffAt);

  if (!Number.isFinite(cutoff)) {
    throw new Error(
      `Invalid evidence cutoff date for market ${market.address}: ${market.evidenceCutoffAt}`,
    );
  }

  const timeRemainingMs = Math.max(0, cutoff - now);

  // This measures suggested source coverage, not actual source availability.
  const suggestedSourceCoverage = Math.min(
    market.dataSources.length / 3,
    1,
  );

  // A later research stage can provide a more informed estimate.
  const suppliedResearchability = getResearchability(
    market.address,
    options.researchability,
  );

  const researchability =
    suppliedResearchability === undefined
      ? suggestedSourceCoverage
      : suppliedResearchability;

  if (
    !Number.isFinite(researchability) ||
    researchability < 0 ||
    researchability > 1
  ) {
    throw new Error(
      `Invalid researchability score for market ${market.address}: ${researchability}`,
    );
  }

  // Markets with at least 24 hours remaining receive the maximum time factor.
  const timeFactor = Math.min(
    timeRemainingMs / (24 * 60 * 60 * 1000),
    1,
  );

  const priorityScore =
    (
      uncertainty * 0.35 +
      researchability * 0.45 +
      timeFactor * 0.2
    ) * 100;

  const priority =
    priorityScore >= 70
      ? "high"
      : priorityScore >= 40
        ? "medium"
        : "low";

  return {
    market,
    yesProbability,
    uncertainty,
    timeRemainingMs,
    suggestedSourceCoverage,
    researchability,
    timeFactor,
    priorityScore,
    priority,
  };
}

/**
 * Analyses and ranks markets from highest to lowest priority.
 */
export function rankMarkets(
  markets: DiscoveredMarket[],
  options: AnalysisOptions = {},
): MarketAnalysis[] {
  return markets
    .map((market) => analyseMarket(market, options))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}

