
import { pathToFileURL } from "node:url";

import {
  EvidenceClient,
  type Submission,
} from "../../src/index.js";

import {
  discoverMarkets,
  getOpenMarkets,
  type DiscoveredMarket,
} from "./market-discovery.js";

import {
  runMarketResearchPipeline,
} from "./market-research-pipeline.js";

import {
  ruleBasedEvidenceAssessor,
} from "./rule-based-assessor.js";

import type {
  ResearchRunnerOptions,
} from "./research-runner.js";

import type {
  EvidenceEvaluation,
} from "./evidence-research.js";

/** Reuses the validated market structure from market-discovery.ts. */
export type MarketCard = DiscoveredMarket;

export interface Fact {
  /** The date the fact is true on, e.g. `2026-11-16`. */
  date: string;
  text: string;
  /** A link to the source of the fact. */
  source: string;
}

/** YES probability in 0..1. Accepts odds as a fraction or percentage. */
export const yesProbability = (market: MarketCard): number =>
  market.odds.yes > 1
    ? market.odds.yes / 100
    : market.odds.yes;

/**
 * Returns open markets before their evidence cutoff,
 * with YES probabilities between 20% and 80%.
 */
export const pickMarkets = (
  markets: MarketCard[],
  now = Date.now(),
): MarketCard[] =>
  getOpenMarkets(markets, now).filter((market) => {
    const probability = yesProbability(market);

    return probability >= 0.2 && probability <= 0.8;
  });

/**
 * Reads one manually supplied fact from the environment.
 * A fact is only associated with its explicitly selected market.
 */
export async function findFact(
  market: MarketCard,
  env = process.env,
): Promise<Fact | null> {
  const fact = env.FACT?.trim();
  const source = env.FACT_SOURCE?.trim();
  const marketAddress = env.MARKET_ADDRESS?.trim();

  if (!fact || !source || !marketAddress) {
    return null;
  }

  if (
    marketAddress.toLowerCase() !==
    market.address.toLowerCase()
  ) {
    return null;
  }

  return {
    date:
      env.FACT_DATE?.trim() ||
      new Date().toISOString().slice(0, 10),
    text: fact,
    source,
  };
}

/**
 * Original manual evidence-submission workflow.
 *
 * This remains separate from research mode.
 */
export async function run(opts: {
  siteUrl: string;
  client: EvidenceClient;
  acceptTerms?: string;
  findFact?: (market: MarketCard) => Promise<Fact | null>;
  fetch?: typeof fetch;
  log?: (...args: unknown[]) => void;
}): Promise<Submission | null> {
  const {
    client,
    log = console.log,
    findFact: find = (market) => findFact(market),
  } = opts;

  const markets = await discoverMarkets({
    siteUrl: opts.siteUrl,
    fetch: opts.fetch,
  });

  const picked = pickMarkets(markets);

  log(`${picked.length} market(s) between 20% and 80%`);

  let termsOk = false;

  for (const market of picked) {
    const fact = await find(market);

    if (!fact) {
      continue;
    }

    if (!termsOk) {
      const { data: terms } = await client.getTerms();

      if (terms.acceptedAt === null) {
        if (opts.acceptTerms !== terms.version) {
          log(
            `would submit to ${market.address} (${market.question}): ` +
              `read the evidence terms at ${terms.url}, then set ` +
              `ACCEPT_TERMS=${terms.version} to accept them and submit`,
          );

          return null;
        }

        await client.acceptTerms(terms.version);

        log(`accepted the evidence terms ${terms.version}`);
      }

      termsOk = true;
    }

    const { data: entry } = await client.getEntryState(
      market.address,
    );

    if (!entry.canSubmit) {
      log(
        `skip ${market.address}: ${entry.reason ?? "cannot submit"}`,
      );

      continue;
    }

    const { data } = await client.submitEvidence({
      note: `As of ${fact.date}: ${fact.text}`,
      links: [fact.source],
      marketAddress: market.address,
    });

    log(
      `submitted ${data.id} to ${market.address} (${data.status})`,
    );

    const result =
      data.status === "rejected"
        ? data
        : (await client.waitForSubmission(data.id)).data;

    log(
      `result: ${result.status}`,
      JSON.stringify(result.markets),
    );

    return result;
  }

  const address = opts.findFact
    ? undefined
    : process.env.MARKET_ADDRESS?.trim();

  if (
    address &&
    !picked.some(
      (market) =>
        market.address.toLowerCase() === address.toLowerCase(),
    )
  ) {
    log(
      `MARKET_ADDRESS ${address} is not among the picked markets ` +
        `(closed, past cutoff, or outside 20%–80%)`,
    );
  } else {
    log(
      "no fact to submit: set FACT, FACT_SOURCE and MARKET_ADDRESS, " +
        "or replace findFact()",
    );
  }

  return null;
}

/**
 * Formats a score as a percentage for human-readable reporting.
 */
function formatScore(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

/**
 * Prints the complete evaluation of one research finding.
 */
function logEvidenceEvaluation(
  evaluation: EvidenceEvaluation,
  index: number,
  log: (...args: unknown[]) => void,
): void {
  const { finding, scores } = evaluation;

  log(`\n${index}. ${finding.claim}`);
  log(`Source: ${finding.sourceName}`);
  log(`Source type: ${finding.sourceType}`);
  log(`Published: ${finding.publishedAt}`);
  log(`Evidence date: ${finding.evidenceDate ?? "Unknown"}`);
  log(`URL: ${finding.sourceUrl}`);

  log("Score breakdown:");
  log(`  Relevance:     ${formatScore(scores.relevance)}`);
  log(`  Credibility:   ${formatScore(scores.credibility)}`);
  log(`  Novelty:       ${formatScore(scores.novelty)}`);
  log(`  Verifiability: ${formatScore(scores.verifiability)}`);
  log(`  Recency:       ${formatScore(scores.recency)}`);
  log(`  Total:         ${formatScore(scores.total)}`);

  log(`Duplicate: ${evaluation.duplicate ? "Yes" : "No"}`);

  log(
    `Recommendation: ${evaluation.recommendation.toUpperCase()}`,
  );

  if (evaluation.relevanceAssessment) {
    log(
      `Assessment direction: ${evaluation.relevanceAssessment.direction}`,
    );

    if (evaluation.relevanceAssessment.relationship) {
      log(
        `Assessment relationship: ${evaluation.relevanceAssessment.relationship}`,
      );
    }

    log(
      `Assessment rationale: ${evaluation.relevanceAssessment.rationale}`,
    );
  }

  if (evaluation.reasons.length > 0) {
    log("Evaluation reasons:");

    for (const reason of evaluation.reasons) {
      log(`  - ${reason}`);
    }
  } else {
    log("Evaluation reasons: No scoring warnings were generated.");
  }
}

/**
 * Research-only execution mode.
 *
 * Discovers and ranks open markets, generates research queries,
 * discovers candidate sources, fetches readable articles, assesses
 * their relevance, evaluates extracted findings and prints a shortlist.
 *
 * It never submits evidence or requires Delphi API credentials.
 */
export async function runResearchMode(opts: {
  siteUrl: string;
  resolutionCriteriaByMarket: Record<string, string>;
  log?: (...args: unknown[]) => void;
  researchOptions?: ResearchRunnerOptions;
}): Promise<void> {
  const log = opts.log ?? console.log;

  const result = await runMarketResearchPipeline({
    siteUrl: opts.siteUrl,

    resolutionCriteriaByMarket:
      opts.resolutionCriteriaByMarket,

    maxMarketsToResearch: 3,

    researchOptions: {
      ...opts.researchOptions,

      assessmentModel:
        opts.researchOptions?.assessmentModel ??
        ruleBasedEvidenceAssessor,
    },
  });

  log("\n========== MARKET RESEARCH SUMMARY ==========");
  log(`Markets discovered: ${result.discoveredCount}`);
  log(`Open markets: ${result.openCount}`);
  log(`Markets ranked: ${result.rankedCount}`);
  log(`Markets researched: ${result.researchedCount}`);

  if (result.skippedMarkets.length > 0) {
    log("\nMarkets skipped (missing criteria or research limit):");

    for (const address of result.skippedMarkets) {
      log(`- ${address}`);
    }
  }

  if (result.researchFailures.length > 0) {
    log("\nMarket research failures:");

    for (const failure of result.researchFailures) {
      log(`- ${failure.marketAddress}: ${failure.reason}`);
    }
  }

  // Display research details market by market.
  for (const entry of result.researches) {
    const {
      market,
      priorityScore,
      research,
      evaluations,
    } = entry;

    log("\n============================================");
    log(`Market: ${market.address}`);
    log(`Question: ${market.question}`);
    log(`Priority score: ${priorityScore.toFixed(2)}`);

    log("\nResearch queries:");

    for (const query of research.plan.queries) {
      log(`- ${query.query}`);
      log(`  Objective: ${query.objective}`);
    }

    log(
      `\nSources discovered: ${research.discovery.sources.length}`,
    );

    for (const source of research.discovery.sources) {
      log(`- ${source.title}`);
      log(`  Publisher: ${source.sourceName}`);
      log(`  URL: ${source.url}`);

      if (source.publishedAt) {
        log(`  Published: ${source.publishedAt}`);
      }

      if (source.snippet) {
        log(`  Snippet: ${source.snippet}`);
      }
    }

    log(
      `\nArticles successfully fetched: ${research.articles.length}`,
    );

    for (const item of research.fetchedArticles) {
      log(`\nArticle: ${item.article.title}`);
      log(`Publisher: ${item.source.sourceName}`);
      log(`Final URL: ${item.article.finalUrl}`);

      if (item.source.publishedAt) {
        log(`Published: ${item.source.publishedAt}`);
      }

      log(
        `Content preview:\n${item.article.content.slice(0, 2000)}`,
      );
    }

    log(
      `\nArticles assessed: ${research.assessments.length}`,
    );

    for (const item of research.assessments) {
      const assessment = item.assessment;

      log(`\nAssessment: ${item.article.title}`);
      log(`Direction: ${assessment.direction}`);

      log(
        `Relevance: ${formatScore(assessment.relevanceScore)}`,
      );

      log(`Rationale: ${assessment.rationale}`);

      if (assessment.supportingStatements.length > 0) {
        log("Potentially relevant source statements:");

        for (const statement of assessment.supportingStatements) {
          log(`- ${statement}`);
        }
      }

      if (assessment.limitations.length > 0) {
        log("Limitations:");

        for (const limitation of assessment.limitations) {
          log(`- ${limitation}`);
        }
      }
    }

    // Display actual evidence scoring results.
    log("\n========== EVIDENCE EVALUATIONS ==========");
    log(`Findings evaluated: ${evaluations.length}`);

    if (evaluations.length === 0) {
      log(
        "No findings were eligible for evidence evaluation. " +
          "Check publication dates and extracted supporting statements.",
      );
    } else {
      evaluations.forEach((evaluation, index) => {
        logEvidenceEvaluation(evaluation, index + 1, log);
      });
    }

    if (research.unassessedArticles > 0) {
      log(
        `\nArticles not assessed: ${research.unassessedArticles}`,
      );
    }

    if (research.discovery.failures.length > 0) {
      log("\nSearch failures:");

      for (const failure of research.discovery.failures) {
        log(`- ${failure.query}: ${failure.reason}`);
      }
    }

    if (research.fetchFailures.length > 0) {
      log("\nArticle fetch failures:");

      for (const failure of research.fetchFailures) {
        log(`- ${failure.source.url}: ${failure.reason}`);
      }
    }

    if (research.assessmentFailures.length > 0) {
      log("\nAssessment failures:");

      for (const failure of research.assessmentFailures) {
        log(`- ${failure.source.url}: ${failure.reason}`);
      }
    }

    log(
      `Articles skipped by fetch limit: ${research.skippedFetches}`,
    );
  }

  // Build the final shortlist from evaluated findings.
  // Each finding is ranked using its combined evidence score.
  const candidates = result.researches
    .flatMap(({ market, evaluations }) =>
      evaluations.map((evaluation) => ({
        market,
        evaluation,
      })),
    )
    .sort(
      (a, b) =>
        b.evaluation.scores.total -
        a.evaluation.scores.total,
    );

  log("\n========== RANKED EVIDENCE SHORTLIST ==========");

  if (candidates.length === 0) {
    log("No findings were eligible for evidence evaluation.");
  } else {
    const shortlist = candidates.slice(0, 10);

    shortlist.forEach(({ market, evaluation }, index) => {
      log(`\n${index + 1}. ${evaluation.finding.claim}`);
      log(`Market: ${market.question}`);
      log(`Market address: ${market.address}`);
      log(`Publisher: ${evaluation.finding.sourceName}`);
      log(`Source type: ${evaluation.finding.sourceType}`);
      log(`Source: ${evaluation.finding.sourceUrl}`);

      log(
        `Total evidence score: ${formatScore(evaluation.scores.total)}`,
      );

      log(
        `Recommendation: ${evaluation.recommendation.toUpperCase()}`,
      );

      log(
        `Relevance: ${formatScore(evaluation.scores.relevance)}`,
      );

      log(
        `Credibility: ${formatScore(evaluation.scores.credibility)}`,
      );

      log(
        `Verifiability: ${formatScore(evaluation.scores.verifiability)}`,
      );

      if (evaluation.reasons.length > 0) {
        log("Reasons:");

        for (const reason of evaluation.reasons) {
          log(`- ${reason}`);
        }
      }
    });
  }

  log(
    "\nIMPORTANT: These are evaluated research candidates, not " +
      "independently verified facts or confirmed market outcomes. " +
      "A strong recommendation reflects the configured scoring rules. " +
      "Verify original sources, event dates, factual claims and " +
      "market resolution criteria before considering submission.",
  );

  log("\nResearch completed. No evidence was submitted.");
}

/**
 * Parses and validates resolution criteria supplied through
 * the environment.
 */
function parseResolutionCriteria(
  raw: string,
): Record<string, string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "RESOLUTION_CRITERIA_JSON must contain valid JSON.",
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "RESOLUTION_CRITERIA_JSON must be a JSON object mapping market addresses to non-empty criteria strings.",
    );
  }

  const entries = Object.entries(parsed);

  if (entries.length === 0) {
    throw new Error(
      "RESOLUTION_CRITERIA_JSON must contain at least one market and its resolution criteria.",
    );
  }

  for (const [address, criteria] of entries) {
    if (!address.trim()) {
      throw new Error(
        "RESOLUTION_CRITERIA_JSON contains an empty market address.",
      );
    }

    if (
      typeof criteria !== "string" ||
      !criteria.trim()
    ) {
      throw new Error(
        `Resolution criteria for market "${address}" must be a non-empty string.`,
      );
    }
  }

  return parsed as Record<string, string>;
}

// Run the agent directly from the command line.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const need = (key: string): string => {
    const value = process.env[key]?.trim();

    if (!value) {
      console.error(`${key} is required`);
      process.exit(1);
    }

    return value;
  };

  const siteUrl = need("COMPETITION_SITE_URL");

  if (process.env.RESEARCH_MODE === "1") {
    // Research mode does not require Delphi API credentials.
    let resolutionCriteriaByMarket: Record<string, string>;

    try {
      resolutionCriteriaByMarket = parseResolutionCriteria(
        need("RESOLUTION_CRITERIA_JSON"),
      );
    } catch (error) {
      console.error(
        "Research mode configuration failed:",
        error,
      );

      process.exit(1);
    }

    runResearchMode({
      siteUrl,
      resolutionCriteriaByMarket,
    }).catch((error) => {
      console.error("Research mode failed:", error);
      process.exit(1);
    });
  } else {
    // Original manual evidence-submission mode.
    run({
      siteUrl,

      client: new EvidenceClient({
        baseUrl: need("DELPHI_API_URL"),

        apiKey:
          process.env.DELPHI_API_ACCESS_KEY?.trim() ||
          process.env.DELPHI_API_KEY?.trim() ||
          need("DELPHI_API_ACCESS_KEY"),

        agentId:
          process.env.AGENT_ID?.trim() || "evidence-starter",

        agentHarness:
          "gensyn-delphi-sdk/examples/evidence-starter",

        agentModel: process.env.AGENT_MODEL?.trim() || undefined,
      }),

      acceptTerms:
        process.env.ACCEPT_TERMS?.trim() || undefined,
    }).catch((error) => {
      console.error("Submission mode failed:", error);
      process.exit(1);
    });
  }
}
