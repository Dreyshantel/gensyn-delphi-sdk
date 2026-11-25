import {
  planResearchQueries,
  type ResearchPlanningInput,
  type ResearchPlan,
  type ResearchQueryGenerator,
} from "./research-planner.js";

import {
  ruleBasedResearchQueryGenerator,
} from "./research-query-generator.js";

import {
  createGoogleNewsRssProvider,
} from "./google-news-provider.js";

import {
  discoverSources,
  type ResearchSearchProvider,
  type SourceDiscoveryOptions,
  type SourceDiscoveryResult,
  type DiscoveredSource,
} from "./source-discovery.js";

import {
  fetchArticle,
  type ArticleFetchResult,
  type ArticleFetcherOptions,
} from "./article-fetcher.js";

import {
  assessEvidence,
  type EvidenceAssessment,
  type EvidenceAssessmentModel,
} from "./evidence-assessor.js";

import { extractEvidenceDate } from "./evidence-dates.js";

export interface ResearchRunnerOptions {
  queryGenerator?: ResearchQueryGenerator;
  searchProvider?: ResearchSearchProvider;
  discoveryOptions?: SourceDiscoveryOptions;
  articleFetcher?: (
    url: string,
    options?: ArticleFetcherOptions,
  ) => Promise<ArticleFetchResult>;
  articleFetchOptions?: ArticleFetcherOptions;
  maxArticlesToFetch?: number;
  now?: number;
  assessmentModel?: EvidenceAssessmentModel;
}

export interface ArticleFetchFailure {
  source: DiscoveredSource;
  reason: string;
}

export interface FetchedResearchArticle {
  source: DiscoveredSource;
  article: ArticleFetchResult;
}

export interface ArticleAssessment {
  source: DiscoveredSource;
  article: ArticleFetchResult;
  assessment: EvidenceAssessment;
}

export interface ArticleAssessmentFailure {
  source: DiscoveredSource;
  reason: string;
}

export interface MarketResearchResult {
  plan: ResearchPlan;
  discovery: SourceDiscoveryResult;
  articles: ArticleFetchResult[];
  fetchedArticles: FetchedResearchArticle[];
  fetchFailures: ArticleFetchFailure[];
  assessments: ArticleAssessment[];
  assessmentFailures: ArticleAssessmentFailure[];
  unassessedArticles: number;
  skippedFetches: number;
}

const RANKING_STOP_WORDS = new Set([
  "about", "after", "again", "also", "among", "because",
  "before", "being", "between", "could", "does", "during",
  "each", "from", "have", "into", "more", "most", "must",
  "only", "other", "over", "same", "should", "some",
  "such", "than", "that", "their", "them", "then",
  "there", "these", "they", "this", "those", "through",
  "under", "until", "very", "were", "what", "when",
  "where", "which", "while", "will", "with", "would",
  "your", "market", "markets", "question",
]);

const JURISDICTION_ALIASES: Record<string, string[]> = {
  Nigeria: ["nigeria", "nigerian"],
  Ghana: ["ghana", "ghanaian"],
  Kenya: ["kenya", "kenyan"],
  "South Africa": ["south africa", "south african"],
  Uganda: ["uganda", "ugandan"],
  Tanzania: ["tanzania", "tanzanian"],
  Rwanda: ["rwanda", "rwandan"],
  Senegal: ["senegal", "senegalese"],
  "United Kingdom": ["united kingdom", "britain", "british"],
  "United States": ["united states", "american", "usa"],
  Canada: ["canada", "canadian"],
  India: ["india", "indian"],
  Australia: ["australia", "australian"],
  Germany: ["germany", "german"],
  France: ["france", "french"],
  China: ["china", "chinese"],
  Japan: ["japan", "japanese"],
  Brazil: ["brazil", "brazilian"],
  Mexico: ["mexico", "mexican"],
  Argentina: ["argentina", "argentinian"],
  Indonesia: ["indonesia", "indonesian"],
  Pakistan: ["pakistan", "pakistani"],
  Bangladesh: ["bangladesh", "bangladeshi"],
  Egypt: ["egypt", "egyptian"],
  Ethiopia: ["ethiopia", "ethiopian"],
};

/**
 * These are explicit domain signals, not a complete publisher
 * credibility database.
 *
 * A matching domain increases shortlist priority. It does not
 * verify the article or prove that its claims are correct.
 */
const NIGERIAN_PRIMARY_SOURCE_DOMAINS = [
  "nigerianstat.gov.ng",
  "cbn.gov.ng",
];

const INTERNATIONAL_INSTITUTION_DOMAINS = [
  "imf.org",
  "worldbank.org",
  "afdb.org",
  "un.org",
  "oecd.org",
  "bis.org",
];

function tokenizeForRanking(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
      .filter((word) => !RANKING_STOP_WORDS.has(word)),
  );
}

function normaliseForMatching(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
}

function findJurisdictions(text: string): Set<string> {
  const normalised = normaliseForMatching(text);
  const matches = new Set<string>();

  for (const [country, aliases] of Object.entries(
    JURISDICTION_ALIASES,
  )) {
    const found = aliases.some((alias) => {
      const normalisedAlias = normaliseForMatching(alias).trim();
      return normalised.includes(` ${normalisedAlias} `);
    });

    if (found) {
      matches.add(country);
    }
  }

  return matches;
}

function detectJurisdiction(text: string): string | undefined {
  return findJurisdictions(text).values().next().value;
}

function getSourceDomain(sourceUrl: string): string | undefined {
  try {
    return new URL(sourceUrl).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function domainMatches(
  domain: string | undefined,
  trustedDomain: string,
): boolean {
  return Boolean(
    domain &&
    (
      domain === trustedDomain ||
      domain.endsWith(`.${trustedDomain}`)
    ),
  );
}

/**
 * Gives recognised Nigerian primary-source domains a strong
 * ranking signal, and relevant international institutions a
 * smaller signal.
 *
 * Generic .gov.ng domains receive a smaller bonus than the
 * explicitly recognised NBS and CBN domains.
 */
function getDomainBonus(
  sourceUrl: string,
  targetJurisdiction: string | undefined,
): number {
  const domain = getSourceDomain(sourceUrl);

  if (!domain) {
    return 0;
  }

  if (targetJurisdiction === "Nigeria") {
    if (
      NIGERIAN_PRIMARY_SOURCE_DOMAINS.some(
        (trustedDomain) => domainMatches(domain, trustedDomain),
      )
    ) {
      return 0.30;
    }

    if (domain === "gov.ng" || domain.endsWith(".gov.ng")) {
      return 0.15;
    }
  }

  if (
    INTERNATIONAL_INSTITUTION_DOMAINS.some(
      (trustedDomain) => domainMatches(domain, trustedDomain),
    )
  ) {
    return 0.08;
  }

  return 0;
}

/**
 * sourceTypes describes the search intent associated with a
 * result. It does not establish the publisher's actual category.
 *
 * Therefore, this is deliberately a small bonus.
 */
function getQueryIntentBonus(
  source: DiscoveredSource,
): number {
  const sourceTypes = source.sourceTypes ?? [];

  let bonus = 0;

  if (
    sourceTypes.includes("official") ||
    sourceTypes.includes("regulatory")
  ) {
    bonus += 0.04;
  }

  if (sourceTypes.includes("academic")) {
    bonus += 0.015;
  }

  return Math.min(bonus, 0.05);
}

/**
 * Ranks discovered sources against the market before article fetching.
 *
 * Ranking signals:
 * - Weighted keyword overlap.
 * - Explicit target-jurisdiction relevance.
 * - Recognised primary-source and international institution domains.
 * - Weak search-intent metadata.
 *
 * A foreign-jurisdiction mention receives a small penalty only when
 * the target jurisdiction is not also mentioned. It is not a rejection.
 *
 * This is a shortlist heuristic, not a semantic relevance model,
 * source verification system, or credibility determination.
 */
function rankSourcesForMarket(
  sources: DiscoveredSource[],
  input: ResearchPlanningInput,
): DiscoveredSource[] {
  const questionTerms = tokenizeForRanking(input.marketQuestion);
  const criteriaTerms = tokenizeForRanking(input.resolutionCriteria);

  const targetWeights = new Map<string, number>();

  for (const term of questionTerms) {
    targetWeights.set(term, (targetWeights.get(term) ?? 0) + 1);
  }

  for (const term of criteriaTerms) {
    targetWeights.set(term, (targetWeights.get(term) ?? 0) + 2);
  }

  const targetText =
    `${input.marketQuestion} ${input.resolutionCriteria}`;

  const targetJurisdiction = detectJurisdiction(targetText);

  return sources
    .map((source, index) => {
      const sourceText = [
        source.title,
        source.snippet ?? "",
        source.sourceName,
      ].join(" ");

      const sourceTerms = tokenizeForRanking(sourceText);

      let totalWeight = 0;
      let matchedWeight = 0;

      for (const [term, weight] of targetWeights) {
        totalWeight += weight;

        if (sourceTerms.has(term)) {
          matchedWeight += weight;
        }
      }

      const topicalScore =
        totalWeight === 0 ? 0 : matchedWeight / totalWeight;

      const sourceJurisdictions = findJurisdictions(sourceText);

      const explicitlyMatchesJurisdiction =
        targetJurisdiction !== undefined &&
        sourceJurisdictions.has(targetJurisdiction);

      const mentionsOnlyOtherJurisdictions =
        targetJurisdiction !== undefined &&
        sourceJurisdictions.size > 0 &&
        !explicitlyMatchesJurisdiction;

      const jurisdictionBonus =
        explicitlyMatchesJurisdiction ? 0.35 : 0;

      const jurisdictionMismatchPenalty =
        mentionsOnlyOtherJurisdictions ? 0.15 : 0;

      const domainBonus = getDomainBonus(
        source.url,
        targetJurisdiction,
      );

      const queryIntentBonus = getQueryIntentBonus(source);

      const score =
        topicalScore +
        jurisdictionBonus +
        domainBonus +
        queryIntentBonus -
        jurisdictionMismatchPenalty;

      return {
        source,
        index,
        score,
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.source);
}

/**
 * Runs the research preparation workflow:
 * 1. Generate a research plan.
 * 2. Discover candidate public sources.
 * 3. Rank candidates against the market.
 * 4. Fetch the highest-ranked candidates within the configured limit.
 * 5. Preserve source provenance.
 * 6. Optionally assess fetched articles.
 *
 * Discovered sources and fetched articles are research candidates.
 * They are not automatically verified or accepted evidence.
 */
export async function runMarketResearch(
  input: ResearchPlanningInput,
  options: ResearchRunnerOptions = {},
): Promise<MarketResearchResult> {
  const queryGenerator =
    options.queryGenerator ?? ruleBasedResearchQueryGenerator;

  const searchProvider =
    options.searchProvider ?? createGoogleNewsRssProvider();

  const articleFetcher =
    options.articleFetcher ?? fetchArticle;

  const maxArticlesToFetch =
    options.maxArticlesToFetch ?? 10;

  if (
    !Number.isInteger(maxArticlesToFetch) ||
    maxArticlesToFetch < 0 ||
    maxArticlesToFetch > 25
  ) {
    throw new Error(
      "maxArticlesToFetch must be an integer between 0 and 25",
    );
  }

  // Stage 1: Generate a validated research plan.
  const plan = await planResearchQueries(
    input,
    queryGenerator,
    options.now,
  );

  // Stage 2: Discover candidate sources.
  const discovery = await discoverSources(
    plan.queries,
    searchProvider,
    options.discoveryOptions,
  );

  // Stage 3: Rank sources before applying the fetch limit.
  const rankedSources = rankSourcesForMarket(
    discovery.sources,
    input,
  );

  const sourcesToFetch = rankedSources.slice(
    0,
    maxArticlesToFetch,
  );

  const articles: ArticleFetchResult[] = [];
  const fetchedArticles: FetchedResearchArticle[] = [];
  const fetchFailures: ArticleFetchFailure[] = [];

  // Stage 4: Fetch the highest-ranked candidates individually.
  for (const source of sourcesToFetch) {
    try {
      const article = await articleFetcher(
        source.url,
        options.articleFetchOptions,
      );

      articles.push(article);

      fetchedArticles.push({
        source,
        article,
      });
    } catch (error) {
      fetchFailures.push({
        source,
        reason:
          error instanceof Error
            ? error.message
            : "Unknown article fetch error",
      });
    }
  }

  // Stage 5: Optionally assess fetched articles.
  const assessments: ArticleAssessment[] = [];
  const assessmentFailures: ArticleAssessmentFailure[] = [];

  if (options.assessmentModel) {
    for (const fetched of fetchedArticles) {
      try {
        /*
         * Prefer the publication date extracted directly from the
         * publisher's HTML. Use the search provider's date only when
         * the fetched article does not expose a publication date.
         *
         * Do not use fetchedAt here: retrieval time is not publication
         * time and cannot establish when the evidence was published.
         * Do not copy the publication date into the evidence date.
         * The evidence date is extracted from the article text and
         * omitted when no admissible event date is present.
         */
        const publishedAt =
          fetched.article.publishedAt ??
          fetched.source.publishedAt;

        if (
          !publishedAt ||
          !Number.isFinite(Date.parse(publishedAt))
        ) {
          throw new Error(
            "A valid publication date is required for assessment",
          );
        }

        const evidenceDate = extractEvidenceDate(
          `${fetched.article.title}\n${fetched.article.content}`,
          {
            publishedAt,
            evidenceCutoffAt: input.evidenceCutoffAt,
            now: options.now,
          },
        );

        const assessment = await assessEvidence(
          {
            marketQuestion: input.marketQuestion,
            resolutionCriteria: input.resolutionCriteria,
            evidenceClaim: fetched.article.title,
            sourceExcerpt: fetched.article.content.slice(0, 12000),
            sourceUrl: fetched.article.finalUrl,
            publishedAt,
            ...(evidenceDate ? { evidenceDate } : {}),
            evidenceCutoffAt: input.evidenceCutoffAt,
          },
          options.assessmentModel,
        );

        assessments.push({
          source: fetched.source,
          article: fetched.article,
          assessment,
        });
      } catch (error) {
        assessmentFailures.push({
          source: fetched.source,
          reason:
            error instanceof Error
              ? error.message
              : "Unknown evidence assessment error",
        });
      }
    }
  }

  return {
    plan,
    discovery,
    articles,
    fetchedArticles,
    fetchFailures,
    assessments,
    assessmentFailures,
    unassessedArticles:
      fetchedArticles.length - assessments.length,
    skippedFetches:
      discovery.sources.length - sourcesToFetch.length,
  };
}
