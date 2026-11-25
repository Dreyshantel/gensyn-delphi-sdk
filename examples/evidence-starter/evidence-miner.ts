/**
 * Turns market research into assessed findings and submission candidates.
 *
 * The free rule-based pipeline has already searched, fetched and screened
 * articles. This stage:
 *
 *   1. groups syndicated copies of the same report (they are not
 *      independent corroboration) and keeps the most credible copy;
 *   2. chooses which articles the LLM reads by a selection score that
 *      combines rule-based relevance, publisher credibility and freshness
 *      (never by keyword overlap alone);
 *   3. asks the LLM to classify each chosen article and, only when it is
 *      justified, extract one dated, quoted, directional fact;
 *   4. scores each directional fact with a transparent value score;
 *   5. marks repeated facts within a market as duplicates.
 *
 * Every article ends up as a Finding with a status and the reasons behind
 * it, so the run can be audited and shown in the panel.
 */

import type { MarketResearchPipelineResult } from "./market-research-pipeline.js";
import type { SubmissionCandidate } from "./submission-eligibility.js";
import { factSimilarity } from "./submission-eligibility.js";
import { extractFact, type FactExtractionOptions, type MarketSpec } from "./fact-extractor.js";
import { LlmBudgetExceededError, type LlmClient } from "./llm-client.js";
import { selectPublicationDate } from "./evidence-dates.js";
import type { DiscoveredMarket } from "./market-discovery.js";
import type { EvidenceDirection, EvidenceRelationship } from "./evidence-assessor.js";
import type { Corroboration, Corroborator } from "./primary-source.js";
import {
  CREDIBILITY_WEIGHT,
  credibilityTier,
  groupSyndicated,
  type CredibilityTier,
} from "./source-credibility.js";

export type FindingStatus =
  /** Directional, passed every check: a submission candidate. */
  | "candidate"
  /** Directional but repeats a stronger candidate's fact on the same market. */
  | "duplicate_fact"
  /** The LLM classified it as context, inconclusive or irrelevant. */
  | "non_directional"
  /** The LLM reply failed a grounding check (quote, date, consistency). */
  | "failed_checks"
  /** A syndicated copy of another fetched article. */
  | "syndicated_copy"
  /** The rule-based screen found it irrelevant. */
  | "screened_out"
  /** Ranked below the per-market LLM limit. */
  | "not_selected"
  /** Only an unrated outlet reports it, and no primary or established source confirmed it. */
  | "needs_primary_source"
  /** Already submitted to this market. */
  | "already_submitted"
  /** The LLM call budget ran out before it was read. */
  | "budget_exhausted";

export interface ValueScoreParts {
  /** LLM confidence that the fact moves the outcome. */
  impact: number;
  /** Publisher credibility prior. */
  credibility: number;
  /** How recent the fact's as-of date is. */
  freshness: number;
  /** Numbers, dates and named entities in the fact. */
  specificity: number;
  /** Rule-based keyword relevance of the article. */
  relevance: number;
}

/** Weights of the value score; they sum to 1. */
export const VALUE_WEIGHTS: ValueScoreParts = {
  impact: 0.3,
  credibility: 0.2,
  freshness: 0.2,
  specificity: 0.15,
  relevance: 0.15,
};

export interface Finding {
  id: string;
  marketAddress: string;
  marketQuestion: string;
  status: FindingStatus;
  reasons: string[];
  url: string;
  title: string;
  publisher: string;
  publishedAt?: string;
  /** "page": stated by the page. "search": only the search listing's date, which can be a re-index date. */
  publishedAtSource?: "page" | "search";
  credibility: CredibilityTier;
  ruleRelevance: number;
  ruleRelationship: EvidenceRelationship;
  relationship?: EvidenceRelationship;
  direction?: EvidenceDirection;
  fact?: string;
  asOfDate?: string;
  quote?: string;
  rationale?: string;
  limitations?: string[];
  confidence?: number;
  valueScore?: number;
  scoreParts?: ValueScoreParts;
  /** For syndicated copies and duplicate facts: the finding kept instead. */
  duplicateOf?: string;
  /** A primary or established source that repeats the fact. */
  corroboratedBy?: Corroboration;
}

export interface ExtractionFailure {
  marketAddress: string;
  url: string;
  reason: string;
}

export interface MiningResult {
  candidates: SubmissionCandidate[];
  findings: Finding[];
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
  /** Structured market readings from the query planner (lower-cased address). */
  specs?: Map<string, MarketSpec>;
  /** Judge feedback to show the LLM for a market, newest first. */
  judgeFeedbackFor?: (marketAddress: string) => string[];
  /**
   * Confirms facts whose only source is an unrated outlet. When set, an
   * unconfirmed fact from an unrated outlet is held as needs_primary_source.
   */
  corroborate?: Corroborator;
  /**
   * Read each directional finding a second time and keep it only when both
   * readings agree on the direction. Free models are not fully stable on
   * borderline articles. Default false.
   */
  confirmDirectional?: boolean;
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
 * forecaster is least likely to know. Only a date stated by the page counts:
 * a search listing's date can be when an old page was re-indexed, so an
 * article with only that date is treated as undated (neutral).
 */
export function freshnessWeight(
  item: { article: { publishedAt?: string }; source: { publishedAt?: string } },
  now: number,
): number {
  const published = Date.parse(item.article.publishedAt ?? "");

  if (!Number.isFinite(published)) {
    return 0.5;
  }

  const ageDays = Math.max(0, (now - published) / DAY_MS);

  if (ageDays <= 3) return 1;
  if (ageDays <= 7) return 0.85;
  if (ageDays <= 30) return 0.65;

  return 0.45;
}

/** Freshness of a fact by its as-of (event) date. */
export function factFreshness(asOfDate: string, now: number): number {
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`);

  if (!Number.isFinite(asOf)) {
    return 0;
  }

  const ageDays = Math.max(0, (now - asOf) / DAY_MS);

  if (ageDays <= 3) return 1;
  if (ageDays <= 7) return 0.85;
  if (ageDays <= 14) return 0.7;
  if (ageDays <= 30) return 0.5;

  return 0.2;
}

/** Specific facts carry numbers, dates and names; vague ones do not. */
export function factSpecificity(fact: string): number {
  let score = 0;

  if (/\d/.test(fact)) score += 0.5;
  // A month counts only next to a number ("20 November", "May 2026"), so "may" the verb does not.
  const month = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  if (new RegExp(`\\d{1,2}(st|nd|rd|th)?\\s+${month}\\b|\\b${month}\\s+\\d|\\b\\d{4}-\\d{2}-\\d{2}\\b`, "i").test(fact)) score += 0.25;
  if (/\s[A-Z][a-z]+/.test(fact)) score += 0.25;

  return Math.min(1, score);
}

export function computeValueScore(parts: ValueScoreParts): number {
  const total = (Object.keys(VALUE_WEIGHTS) as (keyof ValueScoreParts)[]).reduce(
    (sum, key) => sum + VALUE_WEIGHTS[key] * Math.min(1, Math.max(0, parts[key])),
    0,
  );

  return Math.round(total * 1000) / 1000;
}

function findingId(marketAddress: string, url: string): string {
  let hash = 0;

  for (const char of `${marketAddress.toLowerCase()}|${url}`) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
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
    findings: [],
    failures: [],
    articlesSentToLlm: 0,
    budgetExhausted: false,
  };

  for (const entry of research.researches) {
    const { market } = entry;
    const marketKey = market.address.toLowerCase();
    const criteria = criteriaByMarket.get(marketKey) ?? market.question;
    const spec = options.specs?.get(marketKey);
    const feedback = options.judgeFeedbackFor?.(market.address) ?? [];

    // The same page can arrive through two search results: read it once.
    const seenUrls = new Set<string>();
    const uniqueAssessments = entry.research.assessments.filter((item) => {
      const key = item.article.finalUrl.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

      if (seenUrls.has(key)) return false;

      seenUrls.add(key);
      return true;
    });

    const items = uniqueAssessments.map((item) => {
      const publishedAt = selectPublicationDate(item.article.publishedAt, item.source.publishedAt);
      const publishedAtSource: "page" | "search" | undefined = item.article.publishedAt
        ? "page"
        : publishedAt
          ? "search"
          : undefined;
      const credibility = credibilityTier(item.article.finalUrl);
      const finding: Finding = {
        id: findingId(market.address, item.article.finalUrl),
        marketAddress: market.address,
        marketQuestion: market.question,
        status: "not_selected",
        reasons: [],
        url: item.article.finalUrl,
        title: item.article.title,
        publisher: item.source.sourceName,
        ...(publishedAt ? { publishedAt } : {}),
        ...(publishedAtSource ? { publishedAtSource } : {}),
        credibility,
        ruleRelevance: item.assessment.relevanceScore,
        ruleRelationship: item.assessment.relationship,
      };
      const selectionScore =
        item.assessment.relevanceScore * 0.5 +
        CREDIBILITY_WEIGHT[credibility] * 0.25 +
        freshnessWeight(item, now) * 0.25;

      return { item, finding, selectionScore, publishedAt, publishedAtSource };
    });

    // 1. Syndicated copies: keep the best copy of each report.
    const byId = new Map(items.map((i) => [i.finding.id, i]));
    const groups = groupSyndicated(
      items.map((i) => ({ key: i.finding.id, title: i.item.article.title, content: i.item.article.content })),
    );

    for (const group of groups) {
      if (group.length < 2) continue;

      const members = group.map((id) => byId.get(id)!).sort((a, b) => b.selectionScore - a.selectionScore);

      for (const copy of members.slice(1)) {
        copy.finding.status = "syndicated_copy";
        copy.finding.duplicateOf = members[0].finding.id;
        copy.finding.reasons.push(`Same report as ${members[0].finding.publisher}: not independent corroboration`);
      }
    }

    // 2. Screen and select.
    const selectable = items.filter((i) => {
      if (i.finding.status === "syndicated_copy") return false;

      if (i.item.assessment.relationship === "irrelevant" || i.item.assessment.relevanceScore <= 0) {
        i.finding.status = "screened_out";
        i.finding.reasons.push("Rule-based screen: not relevant to the market question");
        return false;
      }

      if (skipArticle(market.address, i.item.article.finalUrl)) {
        i.finding.status = "already_submitted";
        i.finding.reasons.push("This article was already submitted to this market");
        return false;
      }

      return true;
    });

    selectable.sort((a, b) => b.selectionScore - a.selectionScore);

    for (const skipped of selectable.slice(maxArticlesPerMarket)) {
      skipped.finding.reasons.push(
        `Ranked below the top ${maxArticlesPerMarket} by relevance, credibility and freshness`,
      );
    }

    // 3. LLM assessment.
    const marketCandidates: { candidate: SubmissionCandidate; finding: Finding }[] = [];

    for (const chosen of selectable.slice(0, maxArticlesPerMarket)) {
      const { item, finding, publishedAt, publishedAtSource } = chosen;

      if (result.budgetExhausted) {
        finding.status = "budget_exhausted";
        finding.reasons.push("The LLM call budget ran out before this article was read");
        continue;
      }

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
            marketSpec: spec,
            judgeFeedback: feedback,
            article: {
              url: item.article.finalUrl,
              title: item.article.title,
              publisher: item.source.sourceName,
              publishedAt,
              publishedAtSource,
              content: item.article.content,
            },
          },
          options.extraction,
        );
      } catch (error) {
        if (error instanceof LlmBudgetExceededError) {
          log(`\n${error.message}. Stopping extraction; findings so far are kept.`);
          result.budgetExhausted = true;
          result.articlesSentToLlm--;
          finding.status = "budget_exhausted";
          finding.reasons.push("The LLM call budget ran out before this article was read");
          continue;
        }

        throw error;
      }

      if (!extraction.ok) {
        result.failures.push({ marketAddress: market.address, url: item.article.finalUrl, reason: extraction.reason });
        finding.reasons.push(extraction.reason);

        if (extraction.relationship) {
          finding.status = "non_directional";
          finding.relationship = extraction.relationship;
          finding.rationale = extraction.rationale;
          finding.limitations = extraction.limitations;
        } else {
          finding.status = "failed_checks";
        }

        continue;
      }

      const { fact } = extraction;

      if (options.confirmDirectional) {
        let second;

        try {
          second = await extractFact(
            llm,
            {
              marketQuestion: market.question,
              resolutionCriteria: criteria,
              evidenceCutoffAt: market.evidenceCutoffAt,
              yesProbability: marketYesProbability(market),
              marketSpec: spec,
              judgeFeedback: feedback,
              article: {
                url: item.article.finalUrl,
                title: item.article.title,
                publisher: item.source.sourceName,
                publishedAt,
                publishedAtSource,
                content: item.article.content,
              },
            },
            options.extraction,
          );
        } catch (error) {
          if (!(error instanceof LlmBudgetExceededError)) throw error;
          second = { ok: false as const, reason: "The LLM call budget ran out before the second reading" };
          result.budgetExhausted = true;
        }

        if (!second.ok || second.fact.direction !== fact.direction) {
          const disagreement = second.ok
            ? `pointed ${second.fact.direction.toUpperCase()}`
            : second.reason;

          finding.status = "failed_checks";
          finding.relationship = fact.relationship;
          finding.rationale = fact.rationale;
          finding.reasons.push(
            `Second reading disagreed (${disagreement}): the classification is not stable, so it is not submitted`,
          );
          result.failures.push({ marketAddress: market.address, url: item.article.finalUrl, reason: finding.reasons.at(-1)! });
          continue;
        }
      }

      const scoreParts: ValueScoreParts = {
        impact: fact.confidence,
        credibility: CREDIBILITY_WEIGHT[finding.credibility],
        freshness: factFreshness(fact.asOfDate, now),
        specificity: factSpecificity(fact.fact),
        relevance: item.assessment.relevanceScore,
      };
      const valueScore = computeValueScore(scoreParts);

      Object.assign(finding, {
        status: "candidate" as FindingStatus,
        relationship: fact.relationship,
        direction: fact.direction,
        fact: fact.fact,
        asOfDate: fact.asOfDate,
        quote: fact.quote,
        rationale: fact.rationale,
        limitations: fact.limitations,
        confidence: fact.confidence,
        valueScore,
        scoreParts,
      });

      marketCandidates.push({
        finding,
        candidate: {
          marketAddress: market.address,
          marketQuestion: market.question,
          marketStatus: market.status,
          evidenceCutoffAt: market.evidenceCutoffAt,
          direction: fact.direction,
          relationship: fact.relationship,
          fact: fact.fact,
          asOfDate: fact.asOfDate,
          quote: fact.quote,
          sourceUrl: item.article.finalUrl,
          publisher: item.source.sourceName,
          // Only a date stated by the page goes into the note the judge reads.
          ...(publishedAtSource === "page" && publishedAt ? { publishedAt } : {}),
          rationale: fact.rationale,
          limitations: fact.limitations,
          confidence: fact.confidence,
          credibility: finding.credibility,
          valueScore,
        },
      });
    }

    // 4. Unrated outlets: confirm the fact at a primary or established source, or hold it.
    if (options.corroborate) {
      const pool = items.map((i) => ({
        url: i.item.article.finalUrl,
        title: i.item.article.title,
        publisher: i.item.source.sourceName,
        content: i.item.article.content,
      }));

      for (let index = marketCandidates.length - 1; index >= 0; index--) {
        const { candidate, finding } = marketCandidates[index];

        if (finding.credibility !== "unknown") continue;

        const confirmed = await options.corroborate({
          fact: candidate.fact,
          quote: candidate.quote,
          sourceUrl: candidate.sourceUrl,
          pool,
        });

        if (!confirmed) {
          finding.status = "needs_primary_source";
          finding.reasons.push(
            "Only an unrated outlet reports this; no primary or established source confirmed it",
          );
          marketCandidates.splice(index, 1);
          continue;
        }

        finding.corroboratedBy = confirmed;
        finding.reasons.push(`Confirmed by ${confirmed.publisher} (${confirmed.credibility})`);

        // Credibility now rests on the stronger source.
        const parts = { ...finding.scoreParts!, credibility: CREDIBILITY_WEIGHT[confirmed.credibility] };
        finding.scoreParts = parts;
        finding.valueScore = computeValueScore(parts);
        candidate.valueScore = finding.valueScore;
        candidate.supportingLinks = [confirmed.url];
        candidate.corroboratedBy = { publisher: confirmed.publisher, credibility: confirmed.credibility };
      }
    }

    // 5. Repeated facts within the market: keep the highest value score.
    marketCandidates.sort((a, b) => (b.finding.valueScore ?? 0) - (a.finding.valueScore ?? 0));

    const kept: typeof marketCandidates = [];

    for (const current of marketCandidates) {
      const twin = kept.find((k) => factSimilarity(k.candidate.fact, current.candidate.fact) >= 0.6);

      if (twin) {
        current.finding.status = "duplicate_fact";
        current.finding.duplicateOf = twin.finding.id;
        current.finding.reasons.push(`Repeats the fact from ${twin.finding.publisher}`);
      } else {
        kept.push(current);
      }
    }

    result.candidates.push(...kept.map((k) => k.candidate));
    result.findings.push(...items.map((i) => i.finding));

    if (result.budgetExhausted) {
      // Later markets are listed as unread rather than silently dropped.
      continue;
    }
  }

  return result;
}

/**
 * Judge feedback worth showing the LLM: reasons on rejected or unpaid
 * submissions, this market first, then the account's others. Newest first.
 */
export function judgeFeedbackFrom(
  records: { marketAddress: string; status: string; verdict?: string | null; reason?: string | null; zeroPayReason?: string; createdAt: string }[],
  marketAddress: string,
  limit = 5,
): string[] {
  const useful = records
    .filter(
      (r) =>
        r.reason &&
        (r.status === "rejected" ||
          r.zeroPayReason === "below_minimum" ||
          (r.verdict != null && !/accept/i.test(r.verdict))),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const key = marketAddress.toLowerCase();
  const own = useful.filter((r) => r.marketAddress.toLowerCase() === key);
  const others = useful.filter((r) => r.marketAddress.toLowerCase() !== key);

  return [...own, ...others].slice(0, limit).map((r) => r.reason!);
}
