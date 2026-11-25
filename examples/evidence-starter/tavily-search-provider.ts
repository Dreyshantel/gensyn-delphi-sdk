
import type { ResearchQuery } from "./research-planner.js";
import type { ResearchSearchProvider } from "./source-discovery.js";

export interface TavilySearchOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  maxResults?: number;
  timeoutMs?: number;
  searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
  topic?: "general" | "news" | "finance";
}

interface TavilySearchResult {
  title: string;
  url: string;
  sourceName: string;
  snippet?: string;
  publishedAt?: string;
}

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

function getSourceName(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function normalisePublishedDate(
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  return new Date(timestamp).toISOString();
}

/**
 * Converts Tavily's response into the format expected
 * by the existing source discovery engine.
 *
 * Tavily results remain untrusted research candidates.
 */
export function parseTavilySearchResponse(
  response: unknown,
  _query: ResearchQuery,
  maxResults = 10,
): unknown[] {
  if (
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 20
  ) {
    throw new Error(
      "maxResults must be an integer between 1 and 20",
    );
  }

  if (!isRecord(response) || !Array.isArray(response.results)) {
    throw new Error(
      "Tavily returned an invalid search response",
    );
  }

  return response.results
    .slice(0, maxResults)
    .map((item: unknown): TavilySearchResult | null => {
      if (
        !isRecord(item) ||
        typeof item.title !== "string" ||
        typeof item.url !== "string" ||
        typeof item.content !== "string"
      ) {
        return null;
      }

      const title = cleanText(item.title);
      const url = item.url.trim();
      const sourceName = getSourceName(url);
      const snippet = cleanText(item.content);

      if (!title || !url || !sourceName) {
        return null;
      }

      const publishedAt = normalisePublishedDate(
        item.published_date,
      );

      return {
        title,
        url,
        sourceName,
        ...(snippet ? { snippet } : {}),
        ...(publishedAt ? { publishedAt } : {}),
      };
    })
    .filter(
      (item): item is TavilySearchResult => item !== null,
    );
}

/**
 * Creates a Tavily search provider compatible with
 * ResearchSearchProvider.
 *
 * API credentials are read from TAVILY_API_KEY unless
 * explicitly supplied through options.
 */
export function createTavilySearchProvider(
  options: TavilySearchOptions = {},
): ResearchSearchProvider {
  const apiKey =
    options.apiKey ?? process.env.TAVILY_API_KEY;

  const fetchImpl = options.fetch ?? fetch;
  const maxResults = options.maxResults ?? 10;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const searchDepth = options.searchDepth ?? "basic";
  const topic = options.topic ?? "general";

  if (!apiKey?.trim()) {
    throw new Error(
      "TAVILY_API_KEY is required to use the Tavily search provider",
    );
  }

  if (
    !Number.isInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 20
  ) {
    throw new Error(
      "maxResults must be an integer between 1 and 20",
    );
  }

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new Error(
      "timeoutMs must be a positive integer",
    );
  }

  return async (query: ResearchQuery): Promise<unknown> => {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

    try {
      const response = await fetchImpl(
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: query.query,
            search_depth: searchDepth,
            topic,
            max_results: maxResults,
            include_answer: false,
            include_raw_content: false,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(
          `Tavily search failed (HTTP ${response.status})`,
        );
      }

      let data: unknown;

      try {
        data = await response.json();
      } catch {
        throw new Error(
          "Tavily returned an invalid JSON response",
        );
      }

      return parseTavilySearchResponse(
        data,
        query,
        maxResults,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Tavily search timed out after ${timeoutMs}ms`,
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

