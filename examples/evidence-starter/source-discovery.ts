
import type { ResearchQuery } from "./research-planner.js";

export interface DiscoveredSource {
  title: string;
  url: string;
  sourceName: string;
  snippet?: string;
  publishedAt?: string;
  originatingQuery: string;
  sourceTypes: ResearchQuery["sourceTypes"];
}

export interface SourceDiscoveryFailure {
  query: string;
  reason: string;
}

export interface SourceDiscoveryResult {
  sources: DiscoveredSource[];
  failures: SourceDiscoveryFailure[];
  rejectedResults: number;
}

export interface SourceDiscoveryOptions {
  maxResultsPerQuery?: number;
  maxTotalResults?: number;
}

/**
 * A search provider receives one research query and returns
 * untrusted search results.
 *
 * The provider can be replaced without changing the discovery engine.
 */
export type ResearchSearchProvider = (
  query: ResearchQuery,
) => Promise<unknown>;

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normaliseUrl(value: string): string | null {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:") {
      return null;
    }

    url.hash = "";

    return url.toString();
  } catch {
    return null;
  }
}

function parseSearchResult(
  value: unknown,
  query: ResearchQuery,
): DiscoveredSource | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.title !== "string" ||
    typeof value.url !== "string" ||
    typeof value.sourceName !== "string"
  ) {
    return null;
  }

  const title = cleanText(value.title);
  const sourceName = cleanText(value.sourceName);
  const url = normaliseUrl(value.url);

  if (!title || !sourceName || !url) {
    return null;
  }

  let snippet: string | undefined;
  let publishedAt: string | undefined;

  if (value.snippet !== undefined) {
    if (typeof value.snippet !== "string") {
      return null;
    }

    snippet = cleanText(value.snippet);
  }

  if (value.publishedAt !== undefined) {
    if (
      typeof value.publishedAt !== "string" ||
      !Number.isFinite(Date.parse(value.publishedAt))
    ) {
      return null;
    }

    publishedAt = value.publishedAt;
  }

  return {
    title,
    url,
    sourceName,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    originatingQuery: query.query,
    sourceTypes: [...new Set(query.sourceTypes)],
  };
}

/**
 * Execute research queries and collect validated candidate sources.
 *
 * Results are deduplicated by URL. Invalid results are rejected.
 * A failed query does not prevent other queries from running.
 */
export async function discoverSources(
  queries: ResearchQuery[],
  provider: ResearchSearchProvider,
  options: SourceDiscoveryOptions = {},
): Promise<SourceDiscoveryResult> {
  const maxResultsPerQuery = options.maxResultsPerQuery ?? 5;
  const maxTotalResults = options.maxTotalResults ?? 25;

  if (
    !Number.isInteger(maxResultsPerQuery) ||
    maxResultsPerQuery < 1 ||
    maxResultsPerQuery > 20
  ) {
    throw new Error(
      "maxResultsPerQuery must be an integer between 1 and 20",
    );
  }

  if (
    !Number.isInteger(maxTotalResults) ||
    maxTotalResults < 1 ||
    maxTotalResults > 100
  ) {
    throw new Error(
      "maxTotalResults must be an integer between 1 and 100",
    );
  }

  const sources: DiscoveredSource[] = [];
  const failures: SourceDiscoveryFailure[] = [];
  const seenUrls = new Set<string>();

  let rejectedResults = 0;

  for (const query of queries) {
    if (sources.length >= maxTotalResults) {
      break;
    }

    try {
      const response = await provider(query);

      if (!Array.isArray(response)) {
        failures.push({
          query: query.query,
          reason: "Search provider returned an invalid response",
        });

        continue;
      }

      let acceptedForQuery = 0;

      for (const result of response) {
        if (acceptedForQuery >= maxResultsPerQuery) {
          break;
        }

        if (sources.length >= maxTotalResults) {
          break;
        }

        const source = parseSearchResult(result, query);

        if (!source) {
          rejectedResults++;
          continue;
        }

        if (seenUrls.has(source.url)) {
          continue;
        }

        seenUrls.add(source.url);
        sources.push(source);
        acceptedForQuery++;
      }
    } catch (error) {
      failures.push({
        query: query.query,
        reason:
          error instanceof Error
            ? error.message
            : "Unknown search provider error",
      });
    }
  }

  return {
    sources,
    failures,
    rejectedResults,
  };
}

