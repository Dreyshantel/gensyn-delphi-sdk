import { describe, expect, it } from "vitest";

import { buildCriteriaMap, runMineMode } from "../../examples/evidence-starter/agent.js";
import { SubmissionHistory } from "../../examples/evidence-starter/submission-history.js";
import { mineCandidates } from "../../examples/evidence-starter/evidence-miner.js";
import { LlmBudgetExceededError, type LlmClient } from "../../examples/evidence-starter/llm-client.js";
import type { ResearchRunnerOptions } from "../../examples/evidence-starter/research-runner.js";

const now = Date.parse("2026-11-25T12:00:00.000Z");
const marketAddress = "0x1234567890abcdef1234567890abcdef12345678";
const question = "Will Nigeria's annual inflation rate fall below 20 percent by December 2026?";
const articleUrl = "https://www.reuters.com/world/africa/nigeria-inflation";

const articleContent = `
  Nigeria's National Bureau of Statistics published its consumer price index report on 15 November 2026.
  The report said annual inflation fell to 18.2 percent in October 2026, down from 21.5 percent in September.
  Annual inflation has now fallen below the 20 percent threshold for the first time since 2023.
`;

const marketsJson = {
  markets: [
    {
      address: marketAddress,
      question,
      status: "open",
      odds: { yes: 45, no: 55 },
      evidenceCutoffAt: "2026-12-10T17:00:00.000Z",
      dataSources: ["National Bureau of Statistics"],
    },
  ],
};

const competitionFetch: typeof fetch = async () =>
  new Response(JSON.stringify(marketsJson), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const researchOptions: ResearchRunnerOptions = {
  searchProvider: async () => [
    {
      title: "Nigeria annual inflation falls below 20 percent",
      url: articleUrl,
      sourceName: "Example News",
      snippet: "Annual inflation in Nigeria fell to 18.2 percent in October.",
      publishedAt: "2026-11-16T09:00:00.000Z",
    },
  ],
  articleFetcher: async (url) => ({
    requestedUrl: url,
    finalUrl: url,
    title: "Nigeria annual inflation falls below 20 percent",
    content: articleContent,
    contentType: "text/html",
    fetchedAt: new Date(now).toISOString(),
  }),
};

function fakeLlm(reply: unknown, limit = 10): LlmClient {
  let calls = 0;

  return {
    model: "fake",
    get callsMade() {
      return calls;
    },
    async completeJson() {
      if (calls >= limit) {
        throw new LlmBudgetExceededError(limit);
      }

      calls++;
      return reply;
    },
  };
}

const groundedReply = {
  hasFact: true,
  fact: "Nigeria's NBS reported on 15 November 2026 that annual inflation fell to 18.2 percent in October 2026.",
  asOfDate: "2026-11-15",
  direction: "yes",
  quote: "annual inflation fell to 18.2 percent in October 2026",
  dateQuote: "on 15 November 2026",
  rationale: "The official figure is already below the 20 percent threshold.",
  confidence: 0.9,
};

describe("buildCriteriaMap", () => {
  const market = marketsJson.markets[0];

  it("falls back to the market question when no criteria are supplied", () => {
    const criteria = buildCriteriaMap([market], {});

    expect(criteria.get(marketAddress)).toContain(question);
    expect(criteria.get(marketAddress)).toContain("National Bureau of Statistics");
  });

  it("prefers supplied criteria, matching addresses case-insensitively", () => {
    const criteria = buildCriteriaMap([market], { [marketAddress.toUpperCase()]: "Custom criteria." });

    expect(criteria.get(marketAddress)).toBe("Custom criteria.");
  });

  it("leaves out markets whose submission slots are used up", () => {
    expect(buildCriteriaMap([market], {}, () => true).size).toBe(0);
  });
});

describe("mine mode (dry-run)", () => {
  it("researches, extracts a grounded fact and previews the note without submitting", async () => {
    const lines: string[] = [];
    const history = SubmissionHistory.inMemory();

    const { mining, summary } = await runMineMode({
      siteUrl: "https://competition.example",
      fetch: competitionFetch,
      now,
      mode: "dry-run",
      llm: fakeLlm(groundedReply),
      history,
      researchOptions,
      log: (...args) => lines.push(args.join(" ")),
    });

    expect(mining?.candidates).toHaveLength(1);
    expect(mining?.candidates[0]).toMatchObject({ direction: "yes", sourceUrl: articleUrl });
    expect(summary?.previewed).toBe(1);
    expect(history.all()).toHaveLength(0);

    const output = lines.join("\n");
    expect(output).toContain("WOULD SUBMIT");
    expect(output).toContain("As of 2026-11-15:");
    expect(output).toContain("Nothing was sent");
  });

  it("drops a model reply whose quote is not in the article", async () => {
    const { mining, summary } = await runMineMode({
      siteUrl: "https://competition.example",
      fetch: competitionFetch,
      now,
      mode: "dry-run",
      llm: fakeLlm({ ...groundedReply, quote: "inflation collapsed to 9 percent overnight" }),
      history: SubmissionHistory.inMemory(),
      researchOptions,
      log: () => {},
    });

    expect(mining?.candidates).toHaveLength(0);
    expect(mining?.failures[0].reason).toContain("does not appear verbatim");
    expect(summary?.previewed).toBe(0);
  });

  it("skips a malformed market in the live feed instead of failing", async () => {
    const lines: string[] = [];
    const feedWithBadEntry: typeof fetch = async () =>
      new Response(
        JSON.stringify({ markets: [{ address: "0xbad", question: "" }, ...marketsJson.markets] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const { mining } = await runMineMode({
      siteUrl: "https://competition.example",
      fetch: feedWithBadEntry,
      now,
      mode: "dry-run",
      llm: fakeLlm(groundedReply),
      history: SubmissionHistory.inMemory(),
      researchOptions,
      log: (...args) => lines.push(args.join(" ")),
    });

    expect(lines.join("\n")).toContain("Skipped market: Market 0xbad has an invalid question");
    expect(mining?.candidates).toHaveLength(1);
  });

  it("researches without an LLM but submits nothing", async () => {
    const lines: string[] = [];

    const result = await runMineMode({
      siteUrl: "https://competition.example",
      fetch: competitionFetch,
      now,
      mode: "dry-run",
      llm: null,
      history: SubmissionHistory.inMemory(),
      researchOptions,
      log: (...args) => lines.push(args.join(" ")),
    });

    expect(result).toMatchObject({ mining: null, summary: null });
    expect(result.record.metrics.marketsResearched).toBe(1);
    expect(result.record.warnings.join(" ")).toContain("No LLM configured");
    expect(lines.join("\n")).toContain("No LLM configured");
  });

  it("does not send an already-submitted article to the LLM again", async () => {
    const history = SubmissionHistory.inMemory();
    history.add({
      idempotencyKey: "old",
      marketAddress,
      marketQuestion: question,
      direction: "yes",
      fact: "Earlier fact.",
      asOfDate: "2026-11-10",
      sourceUrl: articleUrl,
      publisher: "Example News",
      note: "n",
      links: [articleUrl],
    });
    history.update("old", { status: "judged" });

    const llm = fakeLlm(groundedReply);

    const { mining } = await runMineMode({
      siteUrl: "https://competition.example",
      fetch: competitionFetch,
      now,
      mode: "dry-run",
      llm,
      // Only extraction calls are under test here.
      useLlmQueryPlanner: false,
      history,
      researchOptions,
      log: () => {},
    });

    expect(mining?.articlesSentToLlm).toBe(0);
    expect(llm.callsMade).toBe(0);
  });
});

describe("mineCandidates", () => {
  it("keeps the candidates found before the LLM budget ran out", async () => {
    const research = {
      discoveredCount: 1,
      openCount: 1,
      rankedCount: 1,
      researchedCount: 1,
      skippedMarkets: [],
      researchFailures: [],
      researches: [
        {
          market: marketsJson.markets[0],
          priorityScore: 1,
          evaluations: [],
          research: {
            assessments: [0.9, 0.8].map((score, i) => ({
              source: {
                title: `Distinct report ${i === 0 ? "alpha one" : "beta two"}`,
                url: `${articleUrl}/${i}`,
                sourceName: "Example News",
                originatingQuery: "q",
                sourceTypes: [],
              },
              article: {
                requestedUrl: `${articleUrl}/${i}`,
                finalUrl: `${articleUrl}/${i}`,
                title: `Distinct report ${i === 0 ? "alpha one" : "beta two"}`,
                content: `${i === 0 ? "Opening paragraph A." : "Different opening B."}\n${articleContent}`,
                contentType: "text/html",
                fetchedAt: "",
                publishedAt: "2026-11-16T09:00:00.000Z",
              },
              assessment: {
                relationship: "context" as const,
                relevanceScore: score,
                rationale: "r",
                supportingStatements: [],
                limitations: [],
              },
            })),
          },
        },
      ],
    } as unknown as Parameters<typeof mineCandidates>[0]["research"];

    const result = await mineCandidates({
      research,
      llm: fakeLlm(groundedReply, 1),
      criteriaByMarket: new Map(),
      extraction: { now },
      log: () => {},
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.budgetExhausted).toBe(true);
  });
});

describe("freshnessWeight", () => {
  it("ranks recent articles above old and undated ones", async () => {
    const { freshnessWeight } = await import("../../examples/evidence-starter/evidence-miner.js");
    const at = (publishedAt?: string) => ({ article: { publishedAt }, source: {} });

    expect(freshnessWeight(at("2026-11-24T00:00:00Z"), now)).toBe(1);
    expect(freshnessWeight(at("2026-11-20T00:00:00Z"), now)).toBe(0.85);
    expect(freshnessWeight(at("2026-09-01T00:00:00Z"), now)).toBe(0.45);
    expect(freshnessWeight(at(undefined), now)).toBe(0.5);
  });
});
