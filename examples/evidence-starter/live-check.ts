/**
 * Live accuracy check: the real competition pipeline on representative
 * markets, before (or alongside) the competition's own market list.
 *
 * Runs runMineMode in DRY-RUN with real search, real article fetching, the
 * configured LLM, the real eligibility checks and an empty throwaway
 * history. Nothing is submitted and your real history is not touched.
 * The run record (markets, research, every finding, metrics) is saved to
 * `.delphi-agent/runs/` and shows up in the control panel.
 *
 *   npx tsx examples/evidence-starter/live-check.ts
 *
 * LIVE_CHECK_MARKETS=path/to/markets.json   use your own markets (same format as /markets.json)
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Importing the SDK loads .env from the current folder (DelphiClient calls dotenv).
import "../../src/index.js";

import { buildSearchProvider, runMineMode, searchProviderNames } from "./agent.js";
import { createLlmClientFromEnv } from "./llm-client.js";
import { DEFAULT_RUNS_DIR, type RunRecord } from "./run-record.js";
import { SubmissionHistory } from "./submission-history.js";

/** Representative markets across the competition's topics. Cutoffs move with the clock. */
export function sampleMarkets(now: number) {
  const inDays = (days: number) => new Date(now + days * 86_400_000).toISOString();

  return [
    {
      address: "0xsample000000000000000000000000000000001",
      question: "Will Bitcoin close above $100,000 on 31 December 2026?",
      status: "open",
      odds: { yes: 30, no: 70 },
      evidenceCutoffAt: inDays(14),
      dataSources: ["CoinGecko"],
    },
    {
      address: "0xsample000000000000000000000000000000002",
      question: "Will the US Federal Reserve cut interest rates at its December 2026 FOMC meeting?",
      status: "open",
      odds: { yes: 25, no: 75 },
      evidenceCutoffAt: inDays(14),
      dataSources: ["Federal Reserve"],
    },
    {
      address: "0xsample000000000000000000000000000000003",
      question: "Will Nigeria's headline inflation rate for November 2026 be lower than for October 2026?",
      status: "open",
      odds: { yes: 60, no: 40 },
      evidenceCutoffAt: inDays(21),
      dataSources: ["National Bureau of Statistics"],
    },
    {
      address: "0xsample000000000000000000000000000000004",
      question: "Will Arsenal be top of the Premier League table on 31 December 2026?",
      status: "open",
      odds: { yes: 55, no: 45 },
      evidenceCutoffAt: inDays(14),
      dataSources: [],
    },
  ];
}

export async function runLiveCheck(log: (...args: unknown[]) => void = console.log): Promise<RunRecord> {
  const now = Date.now();
  const path = process.env.LIVE_CHECK_MARKETS?.trim();
  const markets = path ? JSON.parse(readFileSync(path, "utf8")) : { markets: sampleMarkets(now) };
  const llm = createLlmClientFromEnv();

  log(`Live check on ${path ? path : "4 sample markets"}. LLM: ${llm ? llm.model : "not configured (research only)"}.`);
  log("Dry run with a throwaway history: nothing is submitted.\n");

  const { record } = await runMineMode({
    kind: "live-check",
    siteUrl: "https://live-check.local",
    // Serves the sample markets as if they were the competition's /markets.json.
    fetch: async () => new Response(JSON.stringify(markets), { status: 200, headers: { "content-type": "application/json" } }),
    mode: "dry-run",
    llm,
    history: SubmissionHistory.inMemory(),
    maxMarkets: 10,
    researchOptions: { searchProvider: buildSearchProvider() },
    searchProviders: searchProviderNames(),
    runsDir: DEFAULT_RUNS_DIR,
    log,
  });

  const m = record.metrics;
  const pct = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);

  log("\n========== EVALUATION ==========");
  log(`Markets researched:        ${m.marketsResearched}/${m.marketsOpen}`);
  log(`Sources found:             ${m.sourcesFound}`);
  log(`Articles fetched:          ${m.articlesFetched} (success ${pct(m.fetchSuccessRate)})`);
  log(`Articles read by the LLM:  ${m.articlesSentToLlm}`);
  log(`Candidates (checked, directional): ${m.candidates} (${pct(m.candidateRate)} of articles read)`);
  log(`Relationships:             ${JSON.stringify(m.relationships)}`);
  log(`Finding outcomes:          ${JSON.stringify(m.findingsByStatus)}`);
  log(`Invented quotes caught:    ${m.hallucinationsCaught}`);
  log(`Duplicate/syndicated rate: ${pct(m.duplicateRate)}`);
  log(`Candidate credibility:     ${JSON.stringify(m.candidateCredibility)}`);
  log(`Average value score:       ${m.averageValueScore ?? "n/a"}`);
  log(`LLM calls / tokens:        ${m.llmCalls} / ${m.llmTokens ?? "n/a"}`);
  log(`Duration:                  ${Math.round(m.durationMs / 1000)} s`);

  for (const warning of record.warnings) {
    log(`Warning: ${warning}`);
  }

  for (const f of record.findings.filter((x) => x.status === "candidate")) {
    log(`\n[${f.direction?.toUpperCase()} value ${f.valueScore}] ${f.marketQuestion}`);
    log(`  As of ${f.asOfDate}: ${f.fact}`);
    log(`  Quote: "${f.quote}"`);
    log(`  ${f.publisher} (${f.credibility})  ${f.url}`);
  }

  log("\nNothing was submitted. Open the control panel to inspect every finding.");

  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveCheck().catch((error) => {
    console.error("Live check failed:", error);
    process.exit(1);
  });
}
