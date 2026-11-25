/**
 * Turns market research into submission candidates.
 *
 * The free rule-based pipeline has already searched, fetched and screened
 * articles. This stage spends the (rate-limited) LLM only where it is
 * likely to pay off:
 *   - only the top `maxArticlesPerMarket` articles by rule-based relevance,
 *   - never an article already submitted to the same market,
 *   - never an article the screen marked irrelevant.
 *
 * Each LLM reply goes through the grounding checks in fact-extractor.ts.
 */

import type { MarketResearchPipelineResult } from "./market-research-pipeline.js";
import type { SubmissionCandidate } from "./submission-eligibility.js";
import { extractFact, type FactExtractionOptions } from "./fact-extractor.js";
import { LlmBudgetExceededError, type LlmClient } from "./llm-client.js";
import { selectPublicationDate } from "./evidence-dates.js";
import type { DiscoveredMarket } from "./market-discovery.js";

export interface ExtractionFailure {
  marketAddress: string;
  url: string;
  reason: string;
}

export interface MiningResult {
  candidates: SubmissionCandidate[];
  failures: ExtractionFailure[];
  articlesSentToLlm: number;
  /** True when the run stopped because the LLM call budget ran out. */
  budgetExhausted: boolean;
}

export interface MiningOptions {
  research: MarketResearchPipelineResult;
  llm: LlmClient;
  /** Resolution criteria actually used for each market (lower-cased address). */
  criteriaByMarket: Map<string, string>;
  /** Default 3. */
  maxArticlesPerMarket?: number;
  /** Return true to skip an article (e.g. already submitted to this market). */
  skipArticle?: (marketAddress: string, url: string) => boolean;
  extraction?: FactExtractionOptions;
  log?: (...args: unknown[]) => void;
}

/** YES probability in 0..1, from odds given as a fraction or percentage. */
export function marketYesProbability(market: DiscoveredMarket): number {
  return market.odds.yes > 1 ? market.odds.yes / 100 : market.odds.yes;
}

const DAY_MS = 86_400_000;

/**
 * Recent articles first: facts from the last few days are the ones the
 * forecaster is least likely to know. Undated articles rank lowest.
 */
export function freshnessWeight(
  item: { article: { publishedAt?: string }; source: { publishedAt?: string } },
  now: number,
): number {
  const published = Date.parse(
    selectPublicationDate(item.article.publishedAt, item.source.publishedAt) ?? "",
  );

  if (!Number.isFinite(published)) {
    return 0.5;
  }

  const ageDays = Math.max(0, (now - published) / DAY_MS);

  if (ageDays <= 3) return 1;
  if (ageDays <= 7) return 0.85;
  if (ageDays <= 30) return 0.65;

  return 0.45;
}

export async function mineCandidates(options: MiningOptions): Promise<MiningResult> {
  const {
    research,
    llm,
    criteriaByMarket,
    maxArticlesPerMarket = 3,
    skipArticle = () => false,
    log = console.log,
  } = options;
  const now = options.extraction?.now ?? Date.now();

  const result: MiningResult = {
    candidates: [],
    failures: [],
    articlesSentToLlm: 0,
    budgetExhausted: false,
  };

  for (const entry of research.researches) {
    const { market } = entry;
    const criteria =
      criteriaByMarket.get(market.address.toLowerCase()) ?? market.question;

    const ranked = [...entry.research.assessments]
      .filter(
        (item) =>
          item.assessment.relationship !== "irrelevant" &&
          item.assessment.relevanceScore > 0,
      )
      .sort(
        (a, b) =>
          b.assessment.relevanceScore * freshnessWeight(b, now) -
          a.assessment.relevanceScore * freshnessWeight(a, now),
      )
      .filter((item) => !skipArticle(market.address, item.article.finalUrl))
      .slice(0, maxArticlesPerMarket);

    for (const item of ranked) {
      const publishedAt = selectPublicationDate(
        item.article.publishedAt,
        item.source.publishedAt,
      );

      result.articlesSentToLlm++;

      let extraction;

      try {
        extraction = await extractFact(
          llm,
          {
            marketQuestion: market.question,
            resolutionCriteria: criteria,
            evidenceCutoffAt: market.evidenceCutoffAt,
            yesProbability: marketYesProbability(market),
            article: {
              url: item.article.finalUrl,
              title: item.article.title,
              publisher: item.source.sourceName,
              publishedAt,
              content: item.article.content,
            },
          },
          options.extraction,
        );
      } catch (error) {
        if (error instanceof LlmBudgetExceededError) {
          log(`\n${error.message}. Stopping extraction; candidates so far are kept.`);
          result.budgetExhausted = true;
          return result;
        }

        throw error;
      }

      if (!extraction.ok) {
        result.failures.push({
          marketAddress: market.address,
          url: item.article.finalUrl,
          reason: extraction.reason,
        });
        continue;
      }

      const { fact } = extraction;

      result.candidates.push({
        marketAddress: market.address,
        marketQuestion: market.question,
        marketStatus: market.status,
        evidenceCutoffAt: market.evidenceCutoffAt,
        direction: fact.direction,
        fact: fact.fact,
        asOfDate: fact.asOfDate,
        quote: fact.quote,
        sourceUrl: item.article.finalUrl,
        publisher: item.source.sourceName,
        ...(publishedAt ? { publishedAt } : {}),
        rationale: fact.rationale,
        confidence: fact.confidence,
      });
    }
  }

  return result;
}
