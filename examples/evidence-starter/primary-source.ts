/**
 * Primary-source corroboration for findings from unrated outlets.
 *
 * When the only source for a fact is an outlet we cannot rate (often a
 * re-write of an official release, as with a local site restating Fed
 * minutes), the finding is held until the same fact is found at a primary
 * or established source:
 *
 *   1. among the articles already fetched for the market, then
 *   2. with one targeted search, fetching up to two primary/established
 *      results.
 *
 * "Same fact" is checked mechanically against the other article's text:
 * every number in the fact (percentages, amounts, counts; years ignored)
 * must appear, and most of its key terms. No LLM call is spent.
 */

import type { ArticleFetchResult, ArticleFetcherOptions } from "./article-fetcher.js";
import { extractKeyTerms } from "./focused-query-generator.js";
import { normaliseForMatch } from "./fact-extractor.js";
import { credibilityTier, hostnameOf, type CredibilityTier } from "./source-credibility.js";
import { discoverSources, type ResearchSearchProvider } from "./source-discovery.js";

export interface Corroboration {
  url: string;
  title: string;
  publisher: string;
  credibility: CredibilityTier;
  /** "fetched": found among the run's own articles. "search": found by the targeted search. */
  via: "fetched" | "search";
}

export interface CorroborationRequest {
  fact: string;
  quote: string;
  sourceUrl: string;
  /** Articles already fetched for this market. */
  pool: { url: string; title: string; publisher: string; content: string }[];
}

export type Corroborator = (request: CorroborationRequest) => Promise<Corroboration | null>;

const STRONG_TIERS: CredibilityTier[] = ["primary", "established"];

/** Numbers and key terms that another source must repeat to confirm the fact. */
export function factSignals(fact: string, quote: string): { numbers: string[]; terms: string[] } {
  const text = `${fact} ${quote}`;
  const numbers = [
    ...new Set(
      (text.match(/\d[\d,]*(?:\.\d+)?%?/g) ?? [])
        .map((n) => n.replace(/,/g, ""))
        .filter((n) => !/^(19|20)\d{2}$/.test(n) && !/^\d{1,2}$/.test(n)),
    ),
  ];
  const terms = extractKeyTerms(fact, 10)
    .map((t) => t.toLowerCase())
    .filter((t) => !/\d/.test(t) && t.length > 3);

  return { numbers, terms };
}

/** True when `content` repeats the fact's numbers and at least 60% of its key terms. */
export function confirmsFact(content: string, signals: { numbers: string[]; terms: string[] }): boolean {
  const text = normaliseForMatch(content).replace(/(\d),(\d)/g, "$1$2");

  if (signals.numbers.length === 0 && signals.terms.length < 3) {
    return false;
  }

  if (!signals.numbers.every((n) => text.includes(n.toLowerCase()))) {
    return false;
  }

  const hits = signals.terms.filter((t) => text.includes(t)).length;

  return signals.terms.length === 0 || hits / signals.terms.length >= 0.6;
}

export interface CorroboratorOptions {
  searchProvider: ResearchSearchProvider;
  articleFetcher: (url: string, options?: ArticleFetcherOptions) => Promise<ArticleFetchResult>;
  /** Articles fetched from the targeted search. Default 2. */
  maxFetches?: number;
  log?: (...args: unknown[]) => void;
}

export function createCorroborator(options: CorroboratorOptions): Corroborator {
  const maxFetches = options.maxFetches ?? 2;
  const log = options.log ?? (() => {});

  return async (request) => {
    const signals = factSignals(request.fact, request.quote);
    const sourceHost = hostnameOf(request.sourceUrl);

    // 1. Articles already fetched for this market.
    for (const article of request.pool) {
      const tier = credibilityTier(article.url);

      if (STRONG_TIERS.includes(tier) && hostnameOf(article.url) !== sourceHost && confirmsFact(article.content, signals)) {
        return { url: article.url, title: article.title, publisher: article.publisher, credibility: tier, via: "fetched" };
      }
    }

    // 2. One targeted search for the original.
    const query = [...signals.terms.slice(0, 6), ...signals.numbers.slice(0, 2)].join(" ");

    if (!query.trim()) {
      return null;
    }

    let discovered;

    try {
      discovered = await discoverSources(
        [{ query, objective: "Find the primary or an established source for this fact.", sourceTypes: ["official", "news"] }],
        options.searchProvider,
        { maxResultsPerQuery: 10, maxTotalResults: 10 },
      );
    } catch (error) {
      log(`Primary-source search failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    const ranked = discovered.sources
      .map((source) => ({ source, tier: credibilityTier(source.url) }))
      .filter(({ source, tier }) => STRONG_TIERS.includes(tier) && hostnameOf(source.url) !== sourceHost)
      .sort((a, b) => (a.tier === "primary" ? 0 : 1) - (b.tier === "primary" ? 0 : 1))
      .slice(0, maxFetches);

    for (const { source, tier } of ranked) {
      try {
        const article = await options.articleFetcher(source.url);

        if (confirmsFact(article.content, signals)) {
          return { url: article.finalUrl, title: article.title, publisher: source.sourceName, credibility: tier, via: "search" };
        }
      } catch {
        // Unreachable pages simply do not corroborate.
      }
    }

    return null;
  };
}
