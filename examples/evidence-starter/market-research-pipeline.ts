
import {
  runMarketPipeline,
  type MarketPipelineOptions,
} from "./market-pipeline.js";

import {
  runMarketResearch,
  type MarketResearchResult,
  type ResearchRunnerOptions,
} from "./research-runner.js";

import {
  rankFindings,
  type EvidenceEvaluation,
  type EvidenceResearchOptions,
  type ResearchFinding,
} from "./evidence-research.js";

import {
  createEvidenceScoringPolicy,
  type EvidenceScoringPolicyOptions,
} from "./evidence-scoring-policy.js";

import {
  assessSupportingStatement,
} from "./rule-based-assessor.js";

import {
  extractEvidenceDate,
  selectPublicationDate,
} from "./evidence-dates.js";

import type {
  DiscoveredMarket,
} from "./market-discovery.js";

export interface MarketResearchEntry {
  market: DiscoveredMarket;
  priorityScore: number;
  research: MarketResearchResult;
  evaluations: EvidenceEvaluation[];
}

export interface MarketResearchFailure {
  marketAddress: string;
  reason: string;
}

export interface MarketResearchPipelineOptions
  extends MarketPipelineOptions {
  resolutionCriteriaByMarket: Record<string, string>;
  maxMarketsToResearch?: number;
  researchOptions?: Omit<ResearchRunnerOptions, "now">;

  /** Configuration for classifying sources and assigning initial scores. */
  evidenceScoringPolicy?: EvidenceScoringPolicyOptions;

  /** Optional duplicate-detection and scoring-weight configuration. */
  evidenceResearchOptions?: Pick<
    EvidenceResearchOptions,
    "knownClaims" | "weights"
  >;
}

export interface MarketResearchPipelineResult {
  discoveredCount: number;
  openCount: number;
  rankedCount: number;
  researchedCount: number;
  skippedMarkets: string[];
  researchFailures: MarketResearchFailure[];
  researches: MarketResearchEntry[];
}

/**
 * Converts successful article assessments into individual evidence findings.
 *
 * Each extracted statement is independently assessed against the market
 * question and resolution criteria. Article-level relevance is not copied
 * onto every finding.
 *
 * Articles without a valid publication date or relevant statements remain
 * in the research results but are not scored as findings.
 *
 * Publication date, evidence date and discovery date stay separate.
 * An evidence date is recorded only when the statement states an
 * admissible event date. The publication date is never copied in.
 */
function createResearchFindings(
  research: MarketResearchResult,
  marketAddress: string,
  marketQuestion: string,
  resolutionCriteria: string,
  discoveredAt: string,
  evidenceCutoffAt: string,
  now: number,
  scoringPolicy: ReturnType<typeof createEvidenceScoringPolicy>,
): ResearchFinding[] {
  const findings: ResearchFinding[] = [];

  for (const item of research.assessments) {
    const publishedAt = selectPublicationDate(
      item.article.publishedAt,
      item.source.publishedAt,
    );

    if (!publishedAt) {
      continue;
    }

    const sourceUrl = item.article.finalUrl;

    let sourceType: ResearchFinding["sourceType"];

    try {
      sourceType = scoringPolicy.classifySource(sourceUrl);
    } catch {
      // An invalid final URL must not become a scored finding.
      continue;
    }

    for (const statement of item.assessment.supportingStatements) {
      const claim = statement.trim();

      if (!claim) {
        continue;
      }

      const statementAssessment = assessSupportingStatement(
        marketQuestion,
        resolutionCriteria,
        claim,
      );

      if (!statementAssessment.isRelevant) {
        continue;
      }

      const evidenceDate = extractEvidenceDate(claim, {
        publishedAt,
        discoveredAt,
        evidenceCutoffAt,
        now,
      });

      findings.push({
        marketAddress,
        claim,
        sourceUrl,
        sourceName: item.source.sourceName,
        sourceType,
        publishedAt,
        discoveredAt,
        ...(evidenceDate ? { evidenceDate } : {}),
        relevanceAssessment: {
          score: statementAssessment.relevanceScore,
          direction: item.assessment.direction,
          relationship: item.assessment.relationship,
          rationale: [
            item.assessment.rationale,
            statementAssessment.rationale,
          ].join(" "),
        },
      });
    }
  }

  return findings;
}

/**
 * Discovers and ranks markets, researches eligible markets,
 * converts assessed article statements into evidence findings,
 * and ranks those findings for each market.
 *
 * Research failures are isolated per market.
 */
export async function runMarketResearchPipeline(
  options: MarketResearchPipelineOptions,
): Promise<MarketResearchPipelineResult> {
  const {
    resolutionCriteriaByMarket,
    maxMarketsToResearch = 3,
    researchOptions = {},
    evidenceScoringPolicy: scoringPolicyOptions = {},
    evidenceResearchOptions = {},
    ...marketOptions
  } = options;

  if (
    !Number.isInteger(maxMarketsToResearch) ||
    maxMarketsToResearch < 1 ||
    maxMarketsToResearch > 10
  ) {
    throw new Error(
      "maxMarketsToResearch must be an integer between 1 and 10",
    );
  }

  // Capture time once so market filtering, research and evidence
  // evaluation all use the same reference timestamp.
  const now = marketOptions.now ?? Date.now();

  if (!Number.isFinite(now)) {
    throw new Error("Current time must be a valid timestamp");
  }

  const discoveredAt = new Date(now).toISOString();

  const scoringPolicy = createEvidenceScoringPolicy(
    scoringPolicyOptions,
  );

  // Normalise criteria keys so address matching is case-insensitive.
  const criteriaByAddress = new Map<string, string>();

  for (const [address, criteria] of Object.entries(
    resolutionCriteriaByMarket,
  )) {
    criteriaByAddress.set(
      address.toLowerCase(),
      criteria,
    );
  }

  const pipeline = await runMarketPipeline({
    ...marketOptions,
    now,
  });

  // Only research markets with explicitly supplied resolution criteria.
  const eligibleMarkets = pipeline.rankedMarkets.filter(
    ({ market }) => {
      const criteria = criteriaByAddress.get(
        market.address.toLowerCase(),
      );

      return (
        typeof criteria === "string" &&
        criteria.trim().length > 0
      );
    },
  );

  // Markets without resolution criteria cannot be researched safely.
  const marketsWithoutCriteria = pipeline.rankedMarkets
    .filter(({ market }) => {
      const criteria = criteriaByAddress.get(
        market.address.toLowerCase(),
      );

      return (
        typeof criteria !== "string" ||
        criteria.trim().length === 0
      );
    })
    .map(({ market }) => market.address);

  // Apply the configured research limit.
  const selectedMarkets = eligibleMarkets.slice(
    0,
    maxMarketsToResearch,
  );

  // Eligible markets beyond the limit are also reported as skipped.
  const marketsExcludedByLimit = eligibleMarkets
    .slice(maxMarketsToResearch)
    .map(({ market }) => market.address);

  const skippedMarkets = [
    ...new Set([
      ...marketsWithoutCriteria,
      ...marketsExcludedByLimit,
    ]),
  ];

  const researches: MarketResearchEntry[] = [];
  const researchFailures: MarketResearchFailure[] = [];

  // Process markets independently so one failure does not stop the rest.
  for (const analysis of selectedMarkets) {
    const market = analysis.market;

    const resolutionCriteria = criteriaByAddress.get(
      market.address.toLowerCase(),
    );

    // This should already be guaranteed by the eligibility filter.
    if (
      typeof resolutionCriteria !== "string" ||
      resolutionCriteria.trim().length === 0
    ) {
      continue;
    }

    try {
      const research = await runMarketResearch(
        {
          marketAddress: market.address,
          marketQuestion: market.question,
          resolutionCriteria: resolutionCriteria.trim(),
          evidenceCutoffAt: market.evidenceCutoffAt,
          suggestedDataSources: market.dataSources,
        },
        {
          ...researchOptions,
          now,
        },
      );

      const findings = createResearchFindings(
        research,
        market.address,
        market.question,
        resolutionCriteria.trim(),
        discoveredAt,
        market.evidenceCutoffAt,
        now,
        scoringPolicy,
      );

      // Build the URL-specific verifiability map required by rankFindings.
      const verifiability: Record<string, number> = {};

      for (const finding of findings) {
        verifiability[finding.sourceUrl] =
          scoringPolicy.getVerifiability(finding.sourceUrl);
      }

      const evaluations = rankFindings(
        findings,
        market,
        {
          now,
          knownClaims:
            evidenceResearchOptions.knownClaims ?? [],
          relevance: {
            [market.address]: 0,
          },
          credibility: scoringPolicy.credibility,
          verifiability,
          weights: evidenceResearchOptions.weights,
        },
      );

      researches.push({
        market,
        priorityScore: analysis.priorityScore,
        research,
        evaluations,
      });
    } catch (error) {
      researchFailures.push({
        marketAddress: market.address,
        reason:
          error instanceof Error
            ? error.message
            : "Unknown market research error",
      });
    }
  }

  return {
    discoveredCount: pipeline.discoveredCount,
    openCount: pipeline.openCount,
    rankedCount: pipeline.rankedMarkets.length,
    researchedCount: researches.length,
    skippedMarkets,
    researchFailures,
    researches,
  };
}

