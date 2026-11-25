/**
 * A saved record of one agent run: markets, research, every finding and
 * the evaluation metrics. One JSON file per run in `.delphi-agent/runs/`.
 *
 * This is what the control panel shows and what the evaluation measures,
 * so it records what actually happened, including failures and the
 * reasons findings were dropped.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EvidenceRelationship } from "./evidence-assessor.js";
import type { Finding, FindingStatus, MiningResult } from "./evidence-miner.js";
import { marketYesProbability } from "./evidence-miner.js";
import type { MarketSpec } from "./fact-extractor.js";
import type { LlmUsage } from "./llm-client.js";
import type { DiscoveredMarket } from "./market-discovery.js";
import type { MarketResearchPipelineResult } from "./market-research-pipeline.js";
import type { CredibilityTier } from "./source-credibility.js";
import type { SubmissionRunSummary } from "./submission-runner.js";

export const DEFAULT_RUNS_DIR = ".delphi-agent/runs";

export interface MarketRunRecord {
  address: string;
  question: string;
  status: string;
  yesProbability: number;
  evidenceCutoffAt: string;
  dataSources: string[];
  criteria: string | null;
  criteriaSource: "supplied" | "question" | "none";
  spec?: MarketSpec;
  researched: boolean;
  skipReason?: string;
  research?: {
    queries: string[];
    sourcesFound: number;
    publishers: number;
    searchFailures: { query: string; reason: string }[];
    fetched: number;
    fetchFailures: { url: string; reason: string }[];
    assessed: number;
  };
  findingCount: number;
  candidateCount: number;
}

export interface RunMetrics {
  marketsDiscovered: number;
  marketsOpen: number;
  marketsResearched: number;
  researchFailures: number;
  sourcesFound: number;
  articlesFetched: number;
  fetchFailures: number;
  /** fetched / (fetched + failures). */
  fetchSuccessRate: number | null;
  articlesAssessed: number;
  articlesSentToLlm: number;
  candidates: number;
  /** candidates / articles the LLM read: share of read articles that yield a usable, checked fact. */
  candidateRate: number | null;
  /** Replies rejected because the quote was not in the article. */
  hallucinationsCaught: number;
  /** (syndicated copies + duplicate facts) / findings. */
  duplicateRate: number | null;
  findingsByStatus: Partial<Record<FindingStatus, number>>;
  relationships: Partial<Record<EvidenceRelationship, number>>;
  candidateCredibility: Partial<Record<CredibilityTier, number>>;
  averageValueScore: number | null;
  llmCalls: number;
  llmTokens: number | null;
  durationMs: number;
}

export interface RunRecord {
  id: string;
  kind: "mine" | "live-check";
  mode: string;
  startedAt: string;
  finishedAt: string;
  llm: { model: string; calls: number; usage?: LlmUsage } | null;
  searchProviders: string[];
  markets: MarketRunRecord[];
  findings: Finding[];
  submissions: SubmissionRunSummary | null;
  metrics: RunMetrics;
  warnings: string[];
}

function count<T extends string>(values: T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};

  for (const value of values) {
    out[value] = (out[value] ?? 0) + 1;
  }

  return out;
}

const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null);

export interface BuildRunRecordInput {
  kind: RunRecord["kind"];
  mode: string;
  startedAt: number;
  finishedAt: number;
  markets: DiscoveredMarket[];
  openMarkets: DiscoveredMarket[];
  criteriaByMarket: Map<string, string>;
  suppliedCriteria: Set<string>;
  specs: Map<string, MarketSpec>;
  research: MarketResearchPipelineResult | null;
  mining: MiningResult | null;
  submissions: SubmissionRunSummary | null;
  llm: { model: string; callsMade: number; usage?: LlmUsage } | null;
  searchProviders: string[];
  warnings: string[];
}

export function buildRunRecord(input: BuildRunRecordInput): RunRecord {
  const researchByAddress = new Map(
    (input.research?.researches ?? []).map((entry) => [entry.market.address.toLowerCase(), entry]),
  );
  const failures = new Map(
    (input.research?.researchFailures ?? []).map((f) => [f.marketAddress.toLowerCase(), f.reason]),
  );
  const findings = input.mining?.findings ?? [];
  const openKeys = new Set(input.openMarkets.map((m) => m.address.toLowerCase()));

  const markets: MarketRunRecord[] = input.markets.map((market) => {
    const key = market.address.toLowerCase();
    const entry = researchByAddress.get(key);
    const criteria = input.criteriaByMarket.get(key) ?? null;
    const marketFindings = findings.filter((f) => f.marketAddress.toLowerCase() === key);

    let skipReason: string | undefined;

    if (!entry) {
      skipReason = failures.has(key)
        ? `Research failed: ${failures.get(key)}`
        : !openKeys.has(key)
          ? `Not open for evidence (status ${market.status} or past cutoff)`
          : criteria === null
            ? "All submissions on this market are used"
            : "Not in this run's top markets";
    }

    return {
      address: market.address,
      question: market.question,
      status: market.status,
      yesProbability: marketYesProbability(market),
      evidenceCutoffAt: market.evidenceCutoffAt,
      dataSources: market.dataSources,
      criteria,
      criteriaSource: criteria === null ? "none" : input.suppliedCriteria.has(key) ? "supplied" : "question",
      ...(input.specs.get(key) ? { spec: input.specs.get(key) } : {}),
      researched: Boolean(entry),
      ...(skipReason ? { skipReason } : {}),
      ...(entry
        ? {
            research: {
              queries: entry.research.plan.queries.map((q) => q.query),
              sourcesFound: entry.research.discovery.sources.length,
              publishers: new Set(entry.research.discovery.sources.map((s) => s.sourceName)).size,
              searchFailures: entry.research.discovery.failures.map((f) => ({ query: f.query, reason: f.reason })),
              fetched: entry.research.articles.length,
              fetchFailures: entry.research.fetchFailures.map((f) => ({ url: f.source.url, reason: f.reason })),
              assessed: entry.research.assessments.length,
            },
          }
        : {}),
      findingCount: marketFindings.length,
      candidateCount: marketFindings.filter((f) => f.status === "candidate").length,
    };
  });

  const researched = markets.filter((m) => m.research);
  const fetched = researched.reduce((sum, m) => sum + m.research!.fetched, 0);
  const fetchFailures = researched.reduce((sum, m) => sum + m.research!.fetchFailures.length, 0);
  const candidates = findings.filter((f) => f.status === "candidate");
  const sentToLlm = input.mining?.articlesSentToLlm ?? 0;
  const scores = candidates.map((c) => c.valueScore ?? 0);

  const metrics: RunMetrics = {
    marketsDiscovered: input.markets.length,
    marketsOpen: input.openMarkets.length,
    marketsResearched: researched.length,
    researchFailures: failures.size,
    sourcesFound: researched.reduce((sum, m) => sum + m.research!.sourcesFound, 0),
    articlesFetched: fetched,
    fetchFailures,
    fetchSuccessRate: ratio(fetched, fetched + fetchFailures),
    articlesAssessed: researched.reduce((sum, m) => sum + m.research!.assessed, 0),
    articlesSentToLlm: sentToLlm,
    candidates: candidates.length,
    candidateRate: ratio(candidates.length, sentToLlm),
    hallucinationsCaught: findings.filter((f) => f.reasons.some((r) => r.includes("does not appear verbatim"))).length,
    duplicateRate: ratio(
      findings.filter((f) => f.status === "syndicated_copy" || f.status === "duplicate_fact").length,
      findings.length,
    ),
    findingsByStatus: count(findings.map((f) => f.status)),
    relationships: count(findings.filter((f) => f.relationship).map((f) => f.relationship!)),
    candidateCredibility: count(candidates.map((c) => c.credibility)),
    averageValueScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000 : null,
    llmCalls: input.llm?.callsMade ?? 0,
    llmTokens: input.llm?.usage ? input.llm.usage.totalTokens : null,
    durationMs: input.finishedAt - input.startedAt,
  };

  return {
    id: new Date(input.startedAt).toISOString().replace(/[:.]/g, "-"),
    kind: input.kind,
    mode: input.mode,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(input.finishedAt).toISOString(),
    llm: input.llm ? { model: input.llm.model, calls: input.llm.callsMade, ...(input.llm.usage ? { usage: input.llm.usage } : {}) } : null,
    searchProviders: input.searchProviders,
    markets,
    findings,
    submissions: input.submissions,
    metrics,
    warnings: input.warnings,
  };
}

export function saveRunRecord(record: RunRecord, dir = DEFAULT_RUNS_DIR): string {
  mkdirSync(dir, { recursive: true });

  const path = join(dir, `${record.id}.json`);

  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return path;
}

/** Saved runs, newest first. Unreadable files are skipped. */
export function loadRunRecords(dir = DEFAULT_RUNS_DIR, limit = 50): RunRecord[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(dir, name), "utf8")) as RunRecord];
      } catch {
        return [];
      }
    });
}
