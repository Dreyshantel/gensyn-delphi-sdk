
import {
  runMarketResearch,
} from "./research-runner.js";

import {
  createTavilySearchProvider,
} from "./tavily-search-provider.js";

import {
  ruleBasedEvidenceAssessor,
} from "./rule-based-assessor.js";

import {
  buildEvidenceResearchOptions,
  rankFindings,
  type ResearchFinding,
} from "./evidence-research.js";

import {
  extractEvidenceDate,
  selectPublicationDate,
} from "./evidence-dates.js";

import {
  createEvidenceScoringPolicy,
} from "./evidence-scoring-policy.js";

import type {
  DiscoveredMarket,
} from "./market-discovery.js";

// ============================================================
// 1. MARKET CONFIGURATION
// ============================================================

const market = {
  marketAddress: "LIVE-RESEARCH-DIAGNOSTIC",

  marketQuestion:
    "Will Nigeria's annual inflation rate fall below 20 percent by December 2026?",

  resolutionCriteria:
    "The official National Bureau of Statistics consumer price index report published by 31 December 2026 must confirm that annual inflation is below 20 percent.",

  evidenceCutoffAt: "2026-12-31T23:59:59.000Z",

  suggestedDataSources: [
    "National Bureau of Statistics",
    "Central Bank of Nigeria",
    "Official economic reports",
    "Reputable Nigerian news publishers",
  ],
};

// ============================================================
// 2. MARKET ADAPTER FOR EVIDENCE SCORING
// ============================================================

const scoringMarket: DiscoveredMarket = {
  address: market.marketAddress,
  question: market.marketQuestion,
  status: "open",

  odds: {
    yes: 50,
    no: 50,
  },

  evidenceCutoffAt: market.evidenceCutoffAt,
  dataSources: market.suggestedDataSources,
};

// ============================================================
// 3. EVIDENCE SOURCE CLASSIFICATION
// ============================================================

/**
 * Known source-domain classifications.
 *
 * Unknown domains remain classified as "other".
 */
const scoringPolicy = createEvidenceScoringPolicy({
  sourceTypesByDomain: {
    "nigerianstat.gov.ng": "official",
    "cbn.gov.ng": "regulatory",

    "bloomberg.com": "news",
    "nairametrics.com": "news",
    "channelstv.com": "news",
    "thecable.ng": "news",
    "thisdaylive.com": "news",
    "africacheck.org": "news",

    "worldbank.org": "other",
    "africacenter.org": "other",
    "fews.net": "other",
    "deloitte.com": "other",
  },
});

// ============================================================
// 4. DIAGNOSTIC HELPERS
// ============================================================

function printSection(title: string): void {
  console.log(`\n========== ${title} ==========\n`);
}

function isValidDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value))
  );
}

// ============================================================
// 5. FINDING EXTRACTION
// ============================================================

/**
 * Convert successful article assessments into findings.
 *
 * Article publication metadata takes precedence over
 * search-provider publication metadata. The evidence date is
 * extracted from the statement and is left unset when the
 * statement does not contain an admissible event date.
 */
function createResearchFindings(
  assessments: Awaited<
    ReturnType<typeof runMarketResearch>
  >["assessments"],
  discoveredAt: string,
): ResearchFinding[] {
  const findings: ResearchFinding[] = [];

  for (const item of assessments) {
    const publishedAt = selectPublicationDate(
      item.article.publishedAt,
      item.source.publishedAt,
    );

    const sourceUrl = item.article.finalUrl;

    if (!isValidDate(publishedAt)) {
      console.warn(
        `Skipping findings from "${item.article.title}": invalid or missing publication date.`,
      );

      continue;
    }

    let sourceType: ResearchFinding["sourceType"];

    try {
      sourceType = scoringPolicy.classifySource(sourceUrl);
    } catch {
      console.warn(
        `Skipping findings from "${item.article.title}": invalid source URL.`,
      );

      continue;
    }

    for (const statement of item.assessment.supportingStatements) {
      const claim = statement.trim();

      if (!claim) {
        continue;
      }

      const evidenceDate = extractEvidenceDate(claim, {
        publishedAt,
        discoveredAt,
        evidenceCutoffAt: scoringMarket.evidenceCutoffAt,
        now: Date.parse(discoveredAt),
      });

      findings.push({
        marketAddress: scoringMarket.address,
        claim,
        sourceUrl,
        sourceName: item.source.sourceName,
        sourceType,
        publishedAt,
        discoveredAt,
        ...(evidenceDate ? { evidenceDate } : {}),
        relevanceAssessment: {
          score: item.assessment.relevanceScore,
          direction: item.assessment.direction,
          relationship: item.assessment.relationship,
          rationale: item.assessment.rationale,
        },
      });
    }
  }

  return findings;
}

// ============================================================
// 6. MAIN LIVE RESEARCH DIAGNOSTIC
// ============================================================

async function main(): Promise<void> {
  const diagnosticStartedAt = Date.now();

  const discoveredAt = new Date(
    diagnosticStartedAt,
  ).toISOString();

  console.log("\n========================================");
  console.log(" DELPHI LIVE RESEARCH DIAGNOSTIC");
  console.log("========================================\n");

  console.log("Market question:", market.marketQuestion);
  console.log("Evidence cutoff:", market.evidenceCutoffAt);

  console.log("\nSearch provider: Tavily");
  console.log("Search depth: basic");
  console.log("Maximum results per query: 10");

  // ----------------------------------------------------------
  // 6.1 API KEY VALIDATION
  // ----------------------------------------------------------

  if (!process.env.TAVILY_API_KEY?.trim()) {
    throw new Error(
      "TAVILY_API_KEY is missing. Configure it before running live research.",
    );
  }

  // ----------------------------------------------------------
  // 6.2 INITIALISE TAVILY
  // ----------------------------------------------------------

  const tavilyProvider = createTavilySearchProvider({
    maxResults: 10,
    searchDepth: "basic",
    topic: "general",
    timeoutMs: 15_000,
  });

  // ----------------------------------------------------------
  // 6.3 RUN RESEARCH
  // ----------------------------------------------------------

  console.log("\nStarting live research...\n");

  const result = await runMarketResearch(
    market,
    {
      searchProvider: tavilyProvider,

      maxArticlesToFetch: 5,

      assessmentModel: ruleBasedEvidenceAssessor,
    },
  );

  // ----------------------------------------------------------
  // 6.4 RESEARCH PLAN
  // ----------------------------------------------------------

  printSection("RESEARCH PLAN");

  result.plan.queries.forEach((query, index) => {
    console.log(`${index + 1}. ${query.query}`);
    console.log("Objective:", query.objective);

    console.log(
      "Source types:",
      query.sourceTypes.join(", "),
    );

    console.log("");
  });

  // ----------------------------------------------------------
  // 6.5 SOURCE DISCOVERY
  // ----------------------------------------------------------

  printSection("SOURCE DISCOVERY");

  console.log(
    "Sources discovered:",
    result.discovery.sources.length,
  );

  console.log(
    "Rejected results:",
    result.discovery.rejectedResults,
  );

  console.log(
    "Discovery failures:",
    result.discovery.failures.length,
  );

  result.discovery.sources.forEach((source, index) => {
    console.log(`\n${index + 1}. ${source.title}`);
    console.log("Publisher:", source.sourceName);
    console.log("Published:", source.publishedAt ?? "Unknown");
    console.log("URL:", source.url);

    console.log(
      "Originating query:",
      source.originatingQuery,
    );
  });

  result.discovery.failures.forEach((failure, index) => {
    console.log(`\n${index + 1}. Search failure:`);
    console.log(failure);
  });

  // ----------------------------------------------------------
  // 6.6 ARTICLE FETCHING
  // ----------------------------------------------------------

  printSection("ARTICLE FETCHING");

  console.log(
    "Fetch attempts:",
    result.fetchedArticles.length +
      result.fetchFailures.length,
  );

  console.log(
    "Successfully fetched:",
    result.fetchedArticles.length,
  );

  console.log(
    "Failed fetches:",
    result.fetchFailures.length,
  );

  console.log(
    "Skipped fetches:",
    result.skippedFetches,
  );

  result.fetchedArticles.forEach((item, index) => {
    console.log(`\n${index + 1}. ${item.article.title}`);

    console.log("Publisher:", item.source.sourceName);
    console.log("Original URL:", item.source.url);
    console.log("Final URL:", item.article.finalUrl);

    console.log(
      "Content type:",
      item.article.contentType,
    );

    console.log(
      "Extracted characters:",
      item.article.content.length,
    );

    // Display article-level publication metadata.
    console.log(
      "Article publication date:",
      item.article.publishedAt ?? "Unknown",
    );

    console.log(
      "Publication date source:",
      item.article.publicationDateSource ?? "Unknown",
    );

    console.log(
      "Search-provider publication date:",
      item.source.publishedAt ?? "Unknown",
    );

    if (item.article.content.length < 1000) {
      console.warn(
        "WARNING: Short extracted content. Manually verify extraction quality.",
      );
    }
  });

  result.fetchFailures.forEach((failure, index) => {
    console.log(`\n${index + 1}. Fetch failure`);

    console.log("Publisher:", failure.source.sourceName);
    console.log("URL:", failure.source.url);
    console.log("Reason:", failure.reason);
  });

  // ----------------------------------------------------------
  // 6.7 EVIDENCE ASSESSMENT
  // ----------------------------------------------------------

  printSection("EVIDENCE ASSESSMENT");

  console.log(
    "Successful assessments:",
    result.assessments.length,
  );

  console.log(
    "Assessment failures:",
    result.assessmentFailures.length,
  );

  console.log(
    "Unassessed articles:",
    result.unassessedArticles,
  );

  result.assessments.forEach((item, index) => {
    console.log(`\n${index + 1}. ${item.article.title}`);

    console.log("Publisher:", item.source.sourceName);

    console.log(
      "Direction:",
      item.assessment.direction,
    );

    console.log(
      "Relevance:",
      item.assessment.relevanceScore.toFixed(3),
    );

    console.log(
      "Rationale:",
      item.assessment.rationale,
    );

    console.log("\n--- POTENTIALLY SUPPORTING STATEMENTS ---");

    if (
      item.assessment.supportingStatements.length === 0
    ) {
      console.log(
        "No potentially supporting statements extracted.",
      );
    } else {
      item.assessment.supportingStatements.forEach(
        (statement, statementIndex) => {
          console.log(
            `${statementIndex + 1}. ${statement}`,
          );
        },
      );
    }

    console.log("\n--- ASSESSMENT LIMITATIONS ---");

    if (item.assessment.limitations.length === 0) {
      console.log("No limitations reported.");
    } else {
      item.assessment.limitations.forEach(
        (limitation, limitationIndex) => {
          console.log(
            `${limitationIndex + 1}. ${limitation}`,
          );
        },
      );
    }
  });

  result.assessmentFailures.forEach((failure, index) => {
    console.log(`\n${index + 1}. Assessment failure`);

    console.log("Publisher:", failure.source.sourceName);
    console.log("Reason:", failure.reason);
  });

  // ----------------------------------------------------------
  // 6.8 FINDING EXTRACTION
  // ----------------------------------------------------------

  printSection("FINDING EXTRACTION");

  const findings = createResearchFindings(
    result.assessments,
    discoveredAt,
  );

  console.log(
    "Potential evidence findings:",
    findings.length,
  );

  findings.forEach((finding, index) => {
    console.log(`\n${index + 1}. ${finding.claim}`);

    console.log("Publisher:", finding.sourceName);
    console.log("Source type:", finding.sourceType);
    console.log("Published:", finding.publishedAt);
    console.log(
      "Evidence date:",
      finding.evidenceDate ?? "Unknown",
    );
    console.log("URL:", finding.sourceUrl);
  });

  // ----------------------------------------------------------
  // 6.9 EVIDENCE RANKING
  // ----------------------------------------------------------

  printSection("EVIDENCE RANKING");

  const rankedFindings = rankFindings(
    findings,
    scoringMarket,
    buildEvidenceResearchOptions({
      marketAddress: scoringMarket.address,
      findings,
      credibility: scoringPolicy.credibility,
      getVerifiability: (sourceUrl) =>
        scoringPolicy.getVerifiability(sourceUrl),
      now: diagnosticStartedAt,
    }),
  );

  console.log(
    "Ranked findings:",
    rankedFindings.length,
  );

  rankedFindings.forEach((candidate, index) => {
    console.log(`\n${index + 1}. ${candidate.finding.claim}`);

    console.log(
      "Publisher:",
      candidate.finding.sourceName,
    );

    console.log(
      "Overall score:",
      candidate.scores.total.toFixed(4),
    );

    console.log(
      "Relevance score:",
      candidate.scores.relevance.toFixed(3),
    );

    console.log(
      "Credibility score:",
      candidate.scores.credibility.toFixed(3),
    );

    console.log(
      "Verifiability score:",
      candidate.scores.verifiability.toFixed(3),
    );

    console.log(
      "Recommendation:",
      candidate.recommendation,
    );

    const assessment =
      candidate.relevanceAssessment ??
      candidate.finding.relevanceAssessment;

    if (assessment) {
      console.log(
        "Assessment direction:",
        assessment.direction,
      );

      if (assessment.relationship) {
        console.log(
          "Assessment relationship:",
          assessment.relationship,
        );
      }

      console.log(
        "Assessment relevance:",
        assessment.score.toFixed(3),
      );

      console.log(
        "Assessment rationale:",
        assessment.rationale,
      );
    } else {
      console.log(
        "Relevance assessment: not provided",
      );
    }

    if (candidate.reasons.length === 0) {
      console.log(
        "Reasons: none",
      );
    } else {
      console.log("Reasons:");

      candidate.reasons.forEach((reason, reasonIndex) => {
        console.log(`${reasonIndex + 1}. ${reason}`);
      });
    }

    console.log(
      "Source:",
      candidate.finding.sourceUrl,
    );
  });

  // ----------------------------------------------------------
  // 6.10 FINAL DIAGNOSTIC SUMMARY
  // ----------------------------------------------------------

  const durationMs = Date.now() - diagnosticStartedAt;

  printSection("DIAGNOSTIC SUMMARY");

  console.log("Search provider: Tavily");

  console.log(
    "Research queries:",
    result.plan.queries.length,
  );

  console.log(
    "Discovered sources:",
    result.discovery.sources.length,
  );

  console.log(
    "Fetched articles:",
    result.fetchedArticles.length,
  );

  console.log(
    "Assessed articles:",
    result.assessments.length,
  );

  console.log(
    "Potential findings:",
    findings.length,
  );

  console.log(
    "Ranked findings:",
    rankedFindings.length,
  );

  console.log(
    "Total duration:",
    `${(durationMs / 1000).toFixed(2)} seconds`,
  );

  console.log("\n========================================");
  console.log(" LIVE RESEARCH DIAGNOSTIC COMPLETED");
  console.log("========================================\n");

  console.log(
    "IMPORTANT: Findings are research candidates, not verified facts or approved Delphi submissions.",
  );
}

// ============================================================
// 7. EXECUTION AND ERROR HANDLING
// ============================================================

main().catch((error: unknown) => {
  console.error("\nLIVE RESEARCH DIAGNOSTIC FAILED\n");

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});

