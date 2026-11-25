
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

import { createInterface } from "node:readline/promises";

import { createLlmClientFromEnv, type LlmClient } from "./llm-client.js";
import { judgeFeedbackFrom, mineCandidates, type MiningResult } from "./evidence-miner.js";
import { createCorroborator } from "./primary-source.js";
import { fetchArticle } from "./article-fetcher.js";
import type { MarketSpec } from "./fact-extractor.js";
import type { MarketResearchPipelineResult } from "./market-research-pipeline.js";
import { buildRunRecord, DEFAULT_RUNS_DIR, saveRunRecord, type RunRecord } from "./run-record.js";
import { SubmissionHistory, DEFAULT_HISTORY_PATH } from "./submission-history.js";
import {
  refreshVerdicts,
  runSubmissions,
  type SubmissionMode,
  type SubmissionRunSummary,
} from "./submission-runner.js";
import { createGoogleNewsRssProvider } from "./google-news-provider.js";
import { createTavilySearchProvider } from "./tavily-search-provider.js";
import type { ResearchSearchProvider } from "./source-discovery.js";
import {
  createLlmQueryGenerator,
  focusedQueryGenerator,
} from "./focused-query-generator.js";

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
      `Assessment direction: ${evaluation.relevanceAssessment.direction ?? "not established"}`,
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
      log(`Direction: ${assessment.direction ?? "not established"}`);

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
 * Resolution criteria for every open market.
 *
 * Supplied criteria (RESOLUTION_CRITERIA_JSON) win. Otherwise the market
 * question itself is the criterion: competition markets are Yes/No
 * questions, so the question states what resolves them. Markets on which
 * this agent has used all its submissions get no criteria, which makes
 * the pipeline skip them instead of spending research on them.
 */
export function buildCriteriaMap(
  markets: MarketCard[],
  supplied: Record<string, string>,
  isMarketFull: (address: string) => boolean = () => false,
): Map<string, string> {
  const suppliedByAddress = new Map(
    Object.entries(supplied).map(([address, criteria]) => [
      address.toLowerCase(),
      criteria.trim(),
    ]),
  );

  const criteria = new Map<string, string>();

  for (const market of markets) {
    const key = market.address.toLowerCase();

    if (isMarketFull(market.address)) {
      continue;
    }

    const sources =
      market.dataSources.length > 0
        ? ` Relevant data sources: ${market.dataSources.join(", ")}.`
        : "";

    criteria.set(
      key,
      suppliedByAddress.get(key) ||
        `The market resolves YES if the following happens, and NO otherwise: ${market.question}${sources}`,
    );
  }

  return criteria;
}

/**
 * Google News (free, no key) plus Tavily when TAVILY_API_KEY is set.
 * One provider failing does not stop the other.
 */
export function buildSearchProvider(
  env: NodeJS.ProcessEnv = process.env,
): ResearchSearchProvider {
  const providers: ResearchSearchProvider[] = [
    createGoogleNewsRssProvider({
      edition: {
        hl: env.GOOGLE_NEWS_HL?.trim() || "en-US",
        gl: env.GOOGLE_NEWS_GL?.trim() || "US",
      },
    }),
  ];

  if (env.TAVILY_API_KEY?.trim()) {
    const tavily = createTavilySearchProvider({
      maxResults: 8,
      searchDepth: "basic",
      topic: "news",
    });

    // `when:7d` is Google News syntax; Tavily would search for it as text.
    providers.push((query) =>
      tavily({
        ...query,
        query: query.query.replace(/\s*\bwhen:\d+[hdmy]\b/gi, "").trim(),
      }),
    );
  }

  if (providers.length === 1) {
    return providers[0];
  }

  return async (query) => {
    const settled = await Promise.allSettled(
      providers.map((provider) => provider(query)),
    );

    const results = settled.flatMap((outcome) =>
      outcome.status === "fulfilled" && Array.isArray(outcome.value)
        ? outcome.value
        : [],
    );

    if (results.length === 0 && settled.every((o) => o.status === "rejected")) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }

    return results;
  };
}

/** Names of the search providers buildSearchProvider() uses with this environment. */
export function searchProviderNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.TAVILY_API_KEY?.trim() ? ["Google News", "Tavily"] : ["Google News"];
}

export interface MineModeOptions {
  siteUrl: string;
  mode: SubmissionMode;
  /** Without an LLM the agent researches but cannot set a YES/NO direction. */
  llm: LlmClient | null;
  client?: EvidenceClient;
  history: SubmissionHistory;
  resolutionCriteriaByMarket?: Record<string, string>;
  acceptTermsVersion?: string;
  confirm?: (preview: string) => Promise<boolean>;
  /** Markets researched per run (1..10). Default 5. */
  maxMarkets?: number;
  /** Articles sent to the LLM per market. Default 3. */
  maxArticlesPerMarket?: number;
  /** Default 5. */
  maxSubmissionsPerRun?: number;
  minConfidence?: number;
  /** Ask the LLM for search queries and a market spec (one call per market). Default true when an LLM is set. */
  useLlmQueryPlanner?: boolean;
  researchOptions?: ResearchRunnerOptions;
  /** Names of the search providers in use, for the run record. */
  searchProviders?: string[];
  /** Confirm facts from unrated outlets at a primary or established source (one search each). Default true. */
  corroborateUnratedSources?: boolean;
  /** Read each directional finding twice and keep it only if both readings agree. Default true. */
  confirmDirectional?: boolean;
  /** Save the run record to this folder (e.g. DEFAULT_RUNS_DIR). Not saved when omitted. */
  runsDir?: string;
  /** "live-check" runs use sample markets; recorded as such. */
  kind?: RunRecord["kind"];
  fetch?: typeof fetch;
  log?: (...args: unknown[]) => void;
  now?: number;
}

/**
 * Full competition loop: discover → research → assess → check → submit.
 *
 * Safe by default: in "dry-run" nothing is sent. Every run produces a
 * RunRecord (markets, research, every finding, metrics and warnings).
 */
export async function runMineMode(opts: MineModeOptions): Promise<{
  mining: MiningResult | null;
  summary: SubmissionRunSummary | null;
  record: RunRecord;
}> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? Date.now();
  const startedAt = Date.now();
  const maxPerMarket = 3;
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    log(message);
  };

  const markets = await discoverMarkets({
    siteUrl: opts.siteUrl,
    fetch: opts.fetch,
    skipInvalidMarkets: true,
    onInvalidMarket: warn,
  });
  const open = getOpenMarkets(markets, now);
  const supplied = opts.resolutionCriteriaByMarket ?? {};
  const suppliedKeys = new Set(Object.keys(supplied).map((k) => k.toLowerCase()));

  const criteriaByMarket = buildCriteriaMap(
    open,
    supplied,
    (address) => opts.history.forMarket(address).length >= maxPerMarket,
  );

  log(`Markets discovered: ${markets.length}, open: ${open.length}, with slots left: ${criteriaByMarket.size}`);

  const specs = new Map<string, MarketSpec>();
  let research: MarketResearchPipelineResult | null = null;
  let mining: MiningResult | null = null;
  let summary: SubmissionRunSummary | null = null;

  const finish = () => {
    const llm = opts.llm;

    for (const [address, spec] of specs) {
      if (spec.clarity === "ambiguous") {
        warnings.push(`Ambiguous resolution criteria for ${address}: ${spec.notes || "see the market spec"}`);
      }
    }

    if (llm?.usage && llm.usage.rateLimitWaits > 0) {
      warnings.push(`The LLM hit rate limits ${llm.usage.rateLimitWaits} time(s); the run waited and retried`);
    }

    const record = buildRunRecord({
      kind: opts.kind ?? "mine",
      mode: opts.mode,
      startedAt,
      finishedAt: Date.now(),
      markets,
      openMarkets: open,
      criteriaByMarket,
      suppliedCriteria: suppliedKeys,
      specs,
      research,
      mining,
      submissions: summary,
      llm: llm ? { model: llm.model, callsMade: llm.callsMade, usage: llm.usage } : null,
      searchProviders: opts.searchProviders ?? ["custom"],
      warnings,
    });

    if (opts.runsDir) {
      log(`Run record saved to ${saveRunRecord(record, opts.runsDir)}`);
    }

    return { mining, summary, record };
  };

  if (criteriaByMarket.size === 0) {
    log("Nothing to research.");
    return finish();
  }

  const queryGenerator =
    opts.llm && opts.useLlmQueryPlanner !== false
      ? createLlmQueryGenerator(opts.llm, focusedQueryGenerator, (...args) => warn(args.map(String).join(" ")), specs)
      : focusedQueryGenerator;

  research = await runMarketResearchPipeline({
    siteUrl: opts.siteUrl,
    fetch: opts.fetch,
    skipInvalidMarkets: true,
    now,
    resolutionCriteriaByMarket: Object.fromEntries(criteriaByMarket),
    maxMarketsToResearch: Math.min(10, Math.max(1, opts.maxMarkets ?? 5)),
    researchOptions: {
      maxArticlesToFetch: 8,
      queryGenerator,
      preferRecentSources: true,
      ...opts.researchOptions,
      assessmentModel:
        opts.researchOptions?.assessmentModel ?? ruleBasedEvidenceAssessor,
    },
  });

  log(`Markets researched: ${research.researchedCount}`);

  for (const entry of research.researches) {
    log(
      `- ${entry.market.question}\n` +
        `  queries ${entry.research.plan.queries.length}, sources ${entry.research.discovery.sources.length}, ` +
        `fetched ${entry.research.articles.length}, assessed ${entry.research.assessments.length}`,
    );
  }

  for (const failure of research.researchFailures) {
    warn(`Research failed for ${failure.marketAddress}: ${failure.reason}`);
  }

  if (!opts.llm) {
    warn(
      "No LLM configured (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL): research ran, but no evidence " +
        "was assessed and nothing can be submitted.",
    );
    return finish();
  }

  const history = opts.history.all();

  mining = await mineCandidates({
    research,
    llm: opts.llm,
    criteriaByMarket,
    specs,
    judgeFeedbackFor: (address) => judgeFeedbackFrom(history, address),
    confirmDirectional: opts.confirmDirectional !== false,
    corroborate:
      opts.corroborateUnratedSources === false
        ? undefined
        : createCorroborator({
            searchProvider: opts.researchOptions?.searchProvider ?? buildSearchProvider(),
            articleFetcher: opts.researchOptions?.articleFetcher ?? fetchArticle,
            log,
          }),
    maxArticlesPerMarket: opts.maxArticlesPerMarket,
    skipArticle: (marketAddress, url) =>
      opts.history.forMarket(marketAddress).some((record) => record.sourceUrl === url),
    extraction: { now },
    log,
  });

  if (mining.budgetExhausted) {
    warnings.push("The LLM call budget ran out; some articles were not assessed (raise LLM_MAX_CALLS)");
  }

  log(
    `\nArticles assessed by the LLM: ${mining.articlesSentToLlm} ` +
      `(LLM calls this run: ${opts.llm.callsMade}${opts.llm.usage ? `, tokens ${opts.llm.usage.totalTokens}` : ""}), ` +
      `candidates: ${mining.candidates.length}`,
  );

  for (const failure of mining.failures) {
    log(`  not a candidate: ${failure.url}: ${failure.reason}`);
  }

  summary = await runSubmissions({
    candidates: mining.candidates,
    history: opts.history,
    mode: opts.mode,
    client: opts.client,
    acceptTermsVersion: opts.acceptTermsVersion,
    confirm: opts.confirm,
    maxSubmissionsPerRun: opts.maxSubmissionsPerRun,
    minConfidence: opts.minConfidence,
    log,
    // A fixed time for tests; live runs re-read the clock per check.
    now: opts.now === undefined ? Date.now : () => now,
  });

  log("\n========== RUN SUMMARY ==========");
  log(`Mode: ${opts.mode}`);
  log(`Candidates: ${summary.candidates}, eligible: ${summary.eligible}, skipped: ${summary.skipped}`);

  if (opts.mode === "dry-run") {
    log(`Would submit: ${summary.previewed}. Nothing was sent (SUBMIT_MODE=dry-run).`);
  } else {
    log(
      `Submitted: ${summary.submitted} (judged ${summary.judged}, rejected ${summary.rejected}, ` +
        `failed ${summary.failed}), declined: ${summary.declined}, resent: ${summary.resumed}`,
    );
  }

  if (summary.stoppedReason) {
    log(`Stopped early: ${summary.stoppedReason}`);
  }

  return finish();
}

/** Refreshes verdicts and prints the agent's submission record. */
export async function runStatusMode(opts: {
  client: EvidenceClient;
  history: SubmissionHistory;
  log?: (...args: unknown[]) => void;
}): Promise<void> {
  const log = opts.log ?? console.log;

  await refreshVerdicts(opts.client, opts.history, log);

  const records = opts.history.all();
  const markets = new Set(records.map((r) => r.marketAddress.toLowerCase()));
  const judged = records.filter((r) => r.status === "judged");

  log("\n========== SUBMISSION HISTORY ==========");

  for (const record of records) {
    log(
      `${record.createdAt.slice(0, 16)}  ${record.status.padEnd(9)} ${record.direction.toUpperCase().padEnd(3)} ` +
        `${record.bounty ? `${record.bounty.amount} (${record.bounty.state})` : "-"}  ${record.marketQuestion.slice(0, 60)}`,
    );

    if (record.reason) {
      log(`    reason: ${record.reason}`);
    }

    if (record.lastError && record.status === "pending") {
      log(`    unconfirmed: ${record.lastError}`);
    }
  }

  log(
    `\nJudged: ${judged.length} across ${new Set(judged.map((r) => r.marketAddress.toLowerCase())).size} market(s) ` +
      `(prize eligibility needs 10 judged across 3+ markets). Total records: ${records.length} on ${markets.size} market(s).`,
  );
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
  const agentMode = process.env.AGENT_MODE?.trim().toLowerCase();

  const createClient = (): EvidenceClient =>
    new EvidenceClient({
      baseUrl: need("DELPHI_API_URL"),
      apiKey:
        process.env.DELPHI_API_ACCESS_KEY?.trim() ||
        process.env.DELPHI_API_KEY?.trim() ||
        need("DELPHI_API_ACCESS_KEY"),
      agentId: process.env.AGENT_ID?.trim() || "evidence-starter",
      agentHarness:
        process.env.AGENT_HARNESS?.trim() ||
        "gensyn-delphi-sdk/examples/evidence-starter",
      agentModel:
        process.env.AGENT_MODEL?.trim() ||
        process.env.LLM_MODEL?.trim().slice(0, 64) ||
        undefined,
    });

  const optionalInt = (key: string): number | undefined => {
    const raw = process.env[key]?.trim();

    if (!raw) {
      return undefined;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value < 0) {
      console.error(`${key} must be a non-negative integer`);
      process.exit(1);
    }

    return value;
  };

  if (agentMode === "mine" || agentMode === "status") {
    const main = async (): Promise<void> => {
      const history = SubmissionHistory.load(
        process.env.HISTORY_PATH?.trim() || DEFAULT_HISTORY_PATH,
      );

      if (agentMode === "status") {
        await runStatusMode({ client: createClient(), history });
        return;
      }

      const rawMode = process.env.SUBMIT_MODE?.trim().toLowerCase() || "dry-run";

      if (rawMode !== "dry-run" && rawMode !== "approve" && rawMode !== "auto") {
        throw new Error("SUBMIT_MODE must be dry-run, approve or auto");
      }

      const mode: SubmissionMode = rawMode;
      const hasApiKey = Boolean(
        process.env.DELPHI_API_ACCESS_KEY?.trim() || process.env.DELPHI_API_KEY?.trim(),
      );

      // Dry runs use the API read-only when a key is present, so the
      // preview reflects real limits and past submissions.
      const client =
        mode !== "dry-run" || (hasApiKey && process.env.DELPHI_API_URL?.trim())
          ? createClient()
          : undefined;

      const rawCriteria = process.env.RESOLUTION_CRITERIA_JSON?.trim();
      const minConfidenceRaw = process.env.MIN_CONFIDENCE?.trim();
      const minConfidence = minConfidenceRaw ? Number(minConfidenceRaw) : undefined;

      if (minConfidence !== undefined && !(minConfidence >= 0 && minConfidence <= 1)) {
        throw new Error("MIN_CONFIDENCE must be between 0 and 1");
      }

      let readline: ReturnType<typeof createInterface> | undefined;

      const confirm = async (): Promise<boolean> => {
        readline ??= createInterface({ input: process.stdin, output: process.stdout });
        const answer = await readline.question("Submit this? [y/N] ");
        return answer.trim().toLowerCase() === "y";
      };

      try {
        await runMineMode({
          siteUrl,
          mode,
          llm: createLlmClientFromEnv(),
          client,
          history,
          resolutionCriteriaByMarket: rawCriteria ? parseResolutionCriteria(rawCriteria) : {},
          acceptTermsVersion: process.env.ACCEPT_TERMS?.trim() || undefined,
          confirm,
          maxMarkets: optionalInt("MAX_MARKETS"),
          maxArticlesPerMarket: optionalInt("MAX_ARTICLES_PER_MARKET"),
          maxSubmissionsPerRun: optionalInt("MAX_SUBMISSIONS"),
          minConfidence,
          useLlmQueryPlanner: process.env.LLM_QUERY_PLANNER?.trim() !== "0",
          researchOptions: { searchProvider: buildSearchProvider() },
          searchProviders: searchProviderNames(),
          runsDir: DEFAULT_RUNS_DIR,
        });
      } finally {
        readline?.close();
      }
    };

    main().catch((error) => {
      console.error(`${agentMode} mode failed:`, error);
      process.exit(1);
    });
  } else if (process.env.RESEARCH_MODE === "1") {
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
