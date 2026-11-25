/**
 * Market discovery for the Delphi evidence agent.
 *
 * This module retrieves and validates market data independently
 * of the evidence research and submission stages.
 */

export interface DiscoveredMarket {
  address: string;
  question: string;
  status: string;
  odds: {
    yes: number;
    no: number;
  };
  evidenceCutoffAt: string;
  dataSources: string[];
}

export interface MarketDiscoveryOptions {
  siteUrl: string;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidProbability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

/**
 * Validates one market object from the competition API.
 */
function parseMarket(value: unknown, index: number): DiscoveredMarket {
  if (!isRecord(value)) {
    throw new Error(`Market at index ${index} must be an object`);
  }

  const { address, question, status, odds, evidenceCutoffAt, dataSources } = value;

  if (typeof address !== "string" || address.trim() === "") {
    throw new Error(`Market at index ${index} has an invalid address`);
  }

  if (typeof question !== "string" || question.trim() === "") {
    throw new Error(`Market ${address} has an invalid question`);
  }

  if (typeof status !== "string" || status.trim() === "") {
    throw new Error(`Market ${address} has an invalid status`);
  }

  if (!isRecord(odds)) {
    throw new Error(`Market ${address} has invalid odds`);
  }

  if (!isValidProbability(odds.yes) || !isValidProbability(odds.no)) {
    throw new Error(`Market ${address} has invalid YES/NO odds`);
  }

  if (
    typeof evidenceCutoffAt !== "string" ||
    !Number.isFinite(Date.parse(evidenceCutoffAt))
  ) {
    throw new Error(`Market ${address} has an invalid evidence cutoff date`);
  }

  if (
    !Array.isArray(dataSources) ||
    !dataSources.every((source) => typeof source === "string")
  ) {
    throw new Error(`Market ${address} has invalid data sources`);
  }

  return {
    address,
    question,
    status,
    odds: {
      yes: odds.yes,
      no: odds.no,
    },
    evidenceCutoffAt,
    dataSources,
  };
}

/**
 * Supports both API response formats:
 *   [...]
 *   { markets: [...] }
 */
export function parseMarkets(body: unknown): DiscoveredMarket[] {
  const rawMarkets = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.markets)
      ? body.markets
      : null;

  if (!rawMarkets) {
    throw new Error("Invalid markets response: expected an array or { markets: [] }");
  }

  return rawMarkets.map((market, index) => parseMarket(market, index));
}

/**
 * Retrieves and validates the competition market list.
 */
export async function discoverMarkets(
  options: MarketDiscoveryOptions,
): Promise<DiscoveredMarket[]> {
  const fetcher = options.fetch ?? fetch;
  const url = new URL("/markets.json", options.siteUrl).toString();

  const response = await fetcher(url);

  if (!response.ok) {
    throw new Error(`GET /markets.json failed: ${response.status}`);
  }

  const body: unknown = await response.json();

  return parseMarkets(body);
}

/**
 * Returns markets that are open and whose evidence cutoff
 * has not yet passed.
 *
 * This deliberately does not filter by market odds.
 */
export function getOpenMarkets(
  markets: DiscoveredMarket[],
  now = Date.now(),
): DiscoveredMarket[] {
  return markets.filter(
    (market) =>
      market.status.toLowerCase() === "open" &&
      Date.parse(market.evidenceCutoffAt) > now,
  );
}

/**
 * Returns milliseconds remaining until the evidence cutoff.
 * Returns zero when the cutoff has passed.
 */
export function getTimeRemaining(
  market: DiscoveredMarket,
  now = Date.now(),
): number {
  return Math.max(0, Date.parse(market.evidenceCutoffAt) - now);
}
