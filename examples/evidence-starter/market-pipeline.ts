import {
  discoverMarkets,
  getOpenMarkets,
  type MarketDiscoveryOptions,
} from "./market-discovery.js";

import {
  rankMarkets,
  type MarketAnalysis,
} from "./market-analyzer.js";

export interface MarketPipelineOptions extends MarketDiscoveryOptions {
  now?: number;
  researchability?: Record<string, number>;
}

export interface MarketPipelineResult {
  discoveredCount: number;
  openCount: number;
  rankedMarkets: MarketAnalysis[];
}

/**
 * Discovers available markets, filters eligible markets,
 * and ranks them for evidence research.
 */
export async function runMarketPipeline(
  options: MarketPipelineOptions,
): Promise<MarketPipelineResult> {
  const discovered = await discoverMarkets(options);

  const openMarkets = getOpenMarkets(
    discovered,
    options.now ?? Date.now(),
  );

  const rankedMarkets = rankMarkets(openMarkets, {
    now: options.now,
    researchability: options.researchability,
  });

  return {
    discoveredCount: discovered.length,
    openCount: openMarkets.length,
    rankedMarkets,
  };
}
