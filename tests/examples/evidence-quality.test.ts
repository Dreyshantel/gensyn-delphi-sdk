/**
 * Evidence-quality safeguards: relationship classification, direction
 * consistency, context/inconclusive handling, excerpt selection, source
 * credibility, syndication, duplicate facts, value scoring, judge feedback
 * and run metrics.
 */
import { describe, expect, it } from "vitest";

import {
  selectRelevantExcerpt,
  validateExtraction,
  type FactExtractionInput,
} from "../../examples/evidence-starter/fact-extractor.js";
import {
  computeValueScore,
  factFreshness,
  factSpecificity,
  freshnessWeight,
  judgeFeedbackFrom,
  mineCandidates,
  VALUE_WEIGHTS,
} from "../../examples/evidence-starter/evidence-miner.js";
import { credibilityTier, groupSyndicated } from "../../examples/evidence-starter/source-credibility.js";
import { checkEligibility, type SubmissionCandidate } from "../../examples/evidence-starter/submission-eligibility.js";
import { createLlmClient } from "../../examples/evidence-starter/llm-client.js";
import { buildRunRecord } from "../../examples/evidence-starter/run-record.js";
import type { LlmClient } from "../../examples/evidence-starter/llm-client.js";

const now = Date.parse("2026-11-25T12:00:00Z");

const input: FactExtractionInput = {
  marketQuestion: "Will the central bank cut its policy rate at the December 2026 meeting?",
  resolutionCriteria: "YES if the bank announces a cut at its December 2026 meeting.",
  evidenceCutoffAt: "2026-12-10T17:00:00Z",
  article: {
    url: "https://news.example/rates",
    title: "Governor signals pause",
    publisher: "Example News",
    publishedAt: "2026-11-21T09:00:00Z",
    content:
      "On Thursday the governor said the committee sees no case for a cut this year, according to minutes " +
      "released on 20 November 2026. Analysts think rates could fall next spring.",
  },
};

const directional = {
  relationship: "contradiction",
  direction: "no",
  fact: "The governor said on 20 November 2026 that the committee sees no case for a cut this year.",
  asOfDate: "2026-11-20",
  quote: "the committee sees no case for a cut this year",
  dateQuote: "released on 20 November 2026",
  rationale: "A stated no-cut stance lowers the chance of a December cut.",
  limitations: ["Statement, not the decision itself"],
  confidence: 0.8,
};

describe("relationship and direction classification", () => {
  it("accepts contradiction pointing NO, with limitations kept", () => {
    const result = validateExtraction(directional, input, now);

    expect(result).toMatchObject({
      ok: true,
      fact: { relationship: "contradiction", direction: "no", limitations: ["Statement, not the decision itself"] },
    });
  });

  it("infers the direction from the relationship when the model omits it", () => {
    const { direction: _omitted, ...rest } = directional;
    const result = validateExtraction(rest, input, now);

    expect(result.ok && result.fact.direction).toBe("no");
  });

  it("rejects a relationship and direction that disagree", () => {
    const result = validateExtraction({ ...directional, direction: "yes" }, input, now);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("must point NO") });
  });

  it.each(["context", "inconclusive", "irrelevant"])(
    "keeps %s evidence without a direction, even if the model added one",
    (relationship) => {
      const result = validateExtraction(
        { relationship, direction: "yes", rationale: "Only background.", limitations: ["No date"] },
        input,
        now,
      );

      expect(result).toEqual({
        ok: false,
        reason: `Classified as ${relationship}: no YES/NO direction established`,
        relationship,
        rationale: "Only background.",
        limitations: ["No date"],
      });
    },
  );

  it("rejects an unknown relationship value", () => {
    expect(validateExtraction({ ...directional, relationship: "neutral" }, input, now)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Relationship missing"),
    });
  });

  it("refuses a directional finding whose quote is speculation absent from the article", () => {
    const result = validateExtraction({ ...directional, quote: "rates will be cut in December" }, input, now);

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("verbatim") });
  });
});

describe("selectRelevantExcerpt", () => {
  it("keeps the opening paragraph and the most relevant ones within the limit, in order", () => {
    const content = [
      "Opening: the central bank met on Tuesday.",
      "Unrelated paragraph about football results and weather.".repeat(5),
      "The policy rate decision: the bank held its rate at 4.5% in December.",
    ].join("\n");

    const excerpt = selectRelevantExcerpt(content, ["bank", "rate", "December"], 200);

    expect(excerpt.startsWith("Opening:")).toBe(true);
    expect(excerpt).toContain("held its rate at 4.5%");
    expect(excerpt).not.toContain("football");
  });

  it("returns short articles unchanged", () => {
    expect(selectRelevantExcerpt("short text", ["x"], 100)).toBe("short text");
  });
});

describe("source credibility", () => {
  it.each([
    ["https://www.federalreserve.gov/newsevents/x", "primary"],
    ["https://nigerianstat.gov.ng/elibrary", "primary"],
    ["https://www.bls.gov/news.release/cpi.nr0.htm", "primary"],
    ["https://www.reuters.com/markets/x", "established"],
    ["https://businessday.ng/x", "established"],
    ["https://247wallst.com/investing/x", "low"],
    ["https://finance.biggo.com/news/x", "low"],
    ["https://some-local-paper.example/x", "unknown"],
    ["not a url", "low"],
  ])("%s is %s", (url, tier) => {
    expect(credibilityTier(url)).toBe(tier);
  });

  it("blocks a candidate resting only on a low-credibility source", () => {
    const candidate: SubmissionCandidate = {
      marketAddress: "0x1",
      marketQuestion: "q",
      marketStatus: "open",
      evidenceCutoffAt: "2026-12-10T00:00:00Z",
      direction: "no",
      relationship: "contradiction",
      credibility: "low",
      fact: "A specific dated fact about the market on 20 November 2026.",
      asOfDate: "2026-11-20",
      quote: "a quote of sufficient length",
      sourceUrl: "https://247wallst.com/x",
      publisher: "24/7",
      rationale: "",
      confidence: 0.9,
    };

    expect(checkEligibility(candidate, { now, history: [], accountNotes: [] }).reasons).toContain(
      "Only a low-credibility source supports this; find the original report",
    );
    expect(
      checkEligibility({ ...candidate, credibility: "primary", relationship: "context" }, { now, history: [], accountNotes: [] })
        .reasons,
    ).toEqual(["Classified as context, not directional evidence"]);
  });
});

describe("syndication", () => {
  it("groups wire copies by headline and by identical openings", () => {
    const body = "LAGOS (Reuters) - Nigeria's annual inflation rate fell to 14.06% in October, the statistics office said on Monday, ".repeat(3);

    const groups = groupSyndicated([
      { key: "a", title: "Nigeria inflation falls to 14.06% in October - Reuters", content: body },
      { key: "b", title: "Nigeria inflation falls to 14.06% in October - Yahoo Finance", content: body },
      { key: "c", title: "A different headline entirely", content: body },
      { key: "d", title: "Arsenal sign a new striker", content: "Unrelated story." },
    ]);

    expect(groups).toEqual([["a", "b", "c"], ["d"]]);
  });
});

describe("value score", () => {
  it("weights sum to 1 and the score is transparent", () => {
    const total = Object.values(VALUE_WEIGHTS).reduce((a, b) => a + b, 0);

    expect(total).toBeCloseTo(1);
    expect(computeValueScore({ impact: 1, credibility: 1, freshness: 1, specificity: 1, relevance: 1 })).toBe(1);
    expect(computeValueScore({ impact: 0, credibility: 0, freshness: 0, specificity: 0, relevance: 0 })).toBe(0);
  });

  it("does not let keyword relevance alone make a high score", () => {
    const keywordsOnly = computeValueScore({ impact: 0.2, credibility: 0.2, freshness: 0.2, specificity: 0, relevance: 1 });

    expect(keywordsOnly).toBeLessThan(0.4);
  });

  it("rewards fresh, specific facts", () => {
    expect(factFreshness("2026-11-24", now)).toBe(1);
    expect(factFreshness("2026-09-01", now)).toBe(0.2);
    expect(factSpecificity("Inflation fell to 14.06% in October 2026, the NBS said")).toBe(1);
    expect(factSpecificity("things may change soon")).toBe(0);
  });
});

describe("judge feedback loop", () => {
  it("returns rejection reasons, this market's first, newest first", () => {
    const records = [
      { marketAddress: "0xA", status: "judged", verdict: "accepted", reason: "Good", createdAt: "2026-11-25T01:00:00Z" },
      { marketAddress: "0xB", status: "rejected", reason: "Already known", createdAt: "2026-11-25T02:00:00Z" },
      { marketAddress: "0xA", status: "judged", verdict: "no_effect", reason: "Did not move forecast", createdAt: "2026-11-25T03:00:00Z" },
      { marketAddress: "0xA", status: "judged", verdict: "accepted", zeroPayReason: "below_minimum", reason: "Too vague", createdAt: "2026-11-25T04:00:00Z" },
    ];

    expect(judgeFeedbackFrom(records, "0xa")).toEqual(["Too vague", "Did not move forecast", "Already known"]);
  });
});

const article = (i: number, title: string, url: string, content: string) => ({
  source: { title, url, sourceName: `Pub ${i}`, originatingQuery: "q", sourceTypes: [] },
  article: { requestedUrl: url, finalUrl: url, title, content, contentType: "text/html", fetchedAt: "", publishedAt: "2026-11-21T09:00:00Z" },
  assessment: { relationship: "context" as const, relevanceScore: 0.8 - i * 0.1, rationale: "r", supportingStatements: [], limitations: [] },
});

const research = {
  discoveredCount: 1,
  openCount: 1,
  rankedCount: 1,
  researchedCount: 1,
  skippedMarkets: [],
  researchFailures: [],
  researches: [
    {
      market: {
        address: "0xM",
        question: input.marketQuestion,
        status: "open",
        odds: { yes: 40, no: 60 },
        evidenceCutoffAt: input.evidenceCutoffAt,
        dataSources: [],
      },
      priorityScore: 1,
      evaluations: [],
      research: {
        plan: { queries: [{ query: "central bank", objective: "o", sourceTypes: [] }] },
        discovery: { sources: [], failures: [] },
        articles: [],
        fetchFailures: [],
        fetchedArticles: [],
        assessments: [
          article(0, "Governor signals pause on rates", "https://www.reuters.com/a", input.article.content),
          article(1, "Governor signals pause on rates - copy", "https://syndicator.example/a", input.article.content),
          article(2, "Bank history explainer", "https://explainer.example/b", "A long history of the central bank and its governors since 1958, with no new decisions."),
        ],
      },
    },
  ],
} as unknown as Parameters<typeof mineCandidates>[0]["research"];


describe("mineCandidates findings and run metrics", () => {
  const replies = [directional, { relationship: "context", rationale: "History only." }];
  const llm: LlmClient = (() => {
    let calls = 0;
    return {
      model: "fake",
      get callsMade() {
        return calls;
      },
      async completeJson() {
        return replies[calls++];
      },
    };
  })();

  it("records every article's outcome and builds metrics from them", async () => {
    const mining = await mineCandidates({ research, llm, criteriaByMarket: new Map(), extraction: { now }, log: () => {} });

    expect(mining.findings.map((f) => f.status).sort()).toEqual(["candidate", "non_directional", "syndicated_copy"]);

    const candidate = mining.findings.find((f) => f.status === "candidate")!;
    expect(candidate).toMatchObject({ credibility: "established", direction: "no", relationship: "contradiction" });
    expect(candidate.scoreParts).toMatchObject({ impact: 0.8, credibility: 0.8, freshness: 0.85 });
    expect(mining.candidates[0].valueScore).toBe(candidate.valueScore);

    const record = buildRunRecord({
      kind: "live-check",
      mode: "dry-run",
      startedAt: now,
      finishedAt: now + 5000,
      markets: [research.researches[0].market],
      openMarkets: [research.researches[0].market],
      criteriaByMarket: new Map([["0xm", "criteria"]]),
      suppliedCriteria: new Set(),
      specs: new Map(),
      research,
      mining,
      submissions: null,
      llm: { model: "fake", callsMade: 2 },
      searchProviders: ["Google News"],
      warnings: [],
    });

    expect(record.metrics).toMatchObject({
      marketsResearched: 1,
      articlesSentToLlm: 2,
      candidates: 1,
      candidateRate: 0.5,
      duplicateRate: 0.333,
      findingsByStatus: { candidate: 1, non_directional: 1, syndicated_copy: 1 },
      relationships: { contradiction: 1, context: 1 },
      candidateCredibility: { established: 1 },
      durationMs: 5000,
    });
    expect(record.markets[0]).toMatchObject({ criteriaSource: "question", findingCount: 3, candidateCount: 1 });
  });
});

describe("LLM token pacing", () => {
  it("waits when the next call would exceed the per-minute token budget, and records usage", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const llm = createLlmClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      model: "m",
      minIntervalMs: 0,
      tokensPerMinute: 3000,
      maxCompletionTokens: 1000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000 },
          }),
          { status: 200 },
        ),
    });

    const big = [{ role: "user" as const, content: "x".repeat(4000) }];

    await llm.completeJson(big);
    await llm.completeJson(big);

    expect(sleeps.some((ms) => ms >= 59_000)).toBe(true);
    expect(llm.usage).toMatchObject({ promptTokens: 3000, completionTokens: 1000, totalTokens: 4000 });
  });

  it("retries a 429 up to 3 times before giving up", async () => {
    let calls = 0;
    const llm = createLlmClient({
      baseUrl: "https://llm.example/v1",
      apiKey: "k",
      model: "m",
      minIntervalMs: 0,
      sleep: async () => {},
      fetch: async () => {
        calls++;
        return new Response("limited", { status: 429, headers: { "retry-after": "1" } });
      },
    });

    await expect(llm.completeJson([{ role: "user", content: "hi" }])).rejects.toThrow("LLM request failed (429)");
    expect(calls).toBe(4);
    expect(llm.usage?.rateLimitWaits).toBe(3);
  });
});

describe("event dates must come from the article (live-check regression)", () => {
  // Real case from the 25 Nov live check: an official February 2026 round-up,
  // re-listed by Google News on 24 Nov, almost became "current" evidence.
  const staleArticle: FactExtractionInput = {
    marketQuestion: "Will Arsenal be top of the Premier League table on 31 December 2026?",
    resolutionCriteria: "YES if Arsenal are first in the Premier League table on 31 December 2026.",
    evidenceCutoffAt: "2026-12-09T17:00:00Z",
    article: {
      url: "https://www.premierleague.com/ar/news/4597783/the-wrap-whats-happened-in-matchweek-27-so-far/",
      title: "The Wrap: What's happened in Matchweek 27 so far",
      publisher: "Premier League",
      publishedAt: "2026-11-24T00:00:00Z",
      publishedAtSource: "search",
      content:
        "With a comprehensive derby-day victory over neighbours Tottenham Hotspur, Arsenal maintained their five-point lead at the top of the Premier League table to give Spurs' new boss Igor Tudor a baptism of fire. Man Utd are unbeaten since 26 December.",
    },
  };

  const staleReply = {
    relationship: "direct_support",
    direction: "yes",
    fact: "Arsenal maintained their five-point lead at the top of the Premier League table after a derby win over Tottenham Hotspur.",
    asOfDate: "2026-11-24",
    quote: "Arsenal maintained their five-point lead at the top of the Premier League table",
    rationale: "Currently top.",
    confidence: 0.72,
  };

  it("rejects a fact dated only by a search listing", () => {
    expect(validateExtraction(staleReply, staleArticle, now)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("does not state the event date"),
    });
  });

  it("rejects a date quote that is not in the article", () => {
    expect(
      validateExtraction({ ...staleReply, dateQuote: "on 24 November 2026" }, staleArticle, now),
    ).toMatchObject({ ok: false, reason: "The date quote does not appear verbatim in the article" });
  });

  it("rejects a date quote that names a different day", () => {
    expect(
      validateExtraction({ ...staleReply, dateQuote: "since 26 December" }, staleArticle, now),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("does not state the event date") });
  });

  it("accepts relative dates only when the page states its own publication date", () => {
    const article = {
      ...input.article,
      content: "The governor said on Tuesday that the committee sees no case for a cut this year.",
      publishedAt: "2026-11-25T09:00:00Z",
    };
    const reply = {
      ...directional,
      asOfDate: "2026-11-24",
      quote: "the committee sees no case for a cut this year",
      dateQuote: "said on Tuesday",
    };

    expect(validateExtraction(reply, { ...input, article: { ...article, publishedAtSource: "page" } }, now).ok).toBe(true);
    expect(validateExtraction(reply, { ...input, article: { ...article, publishedAtSource: "search" } }, now).ok).toBe(false);
  });

  it("treats an article dated only by search as undated for freshness", () => {
    expect(
      freshnessWeight({ article: {}, source: { publishedAt: "2026-11-24T00:00:00Z" } }, now),
    ).toBe(0.5);
    expect(
      freshnessWeight({ article: { publishedAt: "2026-11-24T00:00:00Z" }, source: {} }, now),
    ).toBe(1);
  });
});

describe("primary-source corroboration for unrated outlets (live-check regression)", () => {
  const minutesFact =
    "The minutes of the Oct. 27-28 meeting, released Nov. 18, said almost all participants judged that further action to raise the target range would likely be appropriate.";
  const officialMinutes =
    "Minutes of the Federal Open Market Committee, October 27-28, 2026. Almost all participants judged that further action to raise the target range for the federal funds rate would likely be appropriate. The minutes were released on November 18.";

  it("extracts the numbers and key terms another source must repeat", async () => {
    const { factSignals } = await import("../../examples/evidence-starter/primary-source.js");

    expect(factSignals("Inflation fell to 14.06% in October 2026, the NBS said.", "")).toMatchObject({
      numbers: ["14.06%"],
    });
  });

  it("confirms from an article the run already fetched, without searching", async () => {
    const { createCorroborator } = await import("../../examples/evidence-starter/primary-source.js");
    let searched = false;

    const corroborate = createCorroborator({
      searchProvider: async () => {
        searched = true;
        return [];
      },
      articleFetcher: async () => {
        throw new Error("not used");
      },
    });

    const result = await corroborate({
      fact: minutesFact,
      quote: minutesFact,
      sourceUrl: "https://aroundprague.cz/en/news/us/fed",
      pool: [
        { url: "https://www.federalreserve.gov/monetarypolicy/fomcminutes20261028.htm", title: "Minutes", publisher: "Federal Reserve", content: officialMinutes },
      ],
    });

    expect(result).toMatchObject({ credibility: "primary", via: "fetched" });
    expect(searched).toBe(false);
  });

  it("searches for the original and confirms it from the fetched page", async () => {
    const { createCorroborator } = await import("../../examples/evidence-starter/primary-source.js");
    const fetched: string[] = [];

    const corroborate = createCorroborator({
      searchProvider: async () => [
        { title: "Blog repost", url: "https://some-blog.example/fed", sourceName: "Blog" },
        { title: "FOMC minutes", url: "https://www.federalreserve.gov/monetarypolicy/fomcminutes20261028.htm", sourceName: "Federal Reserve" },
      ],
      articleFetcher: async (url) => {
        fetched.push(url);
        return { requestedUrl: url, finalUrl: url, title: "FOMC minutes", content: officialMinutes, contentType: "text/html", fetchedAt: "" };
      },
    });

    const result = await corroborate({ fact: minutesFact, quote: minutesFact, sourceUrl: "https://aroundprague.cz/x", pool: [] });

    expect(result).toMatchObject({ publisher: "Federal Reserve", credibility: "primary", via: "search" });
    expect(fetched).toEqual(["https://www.federalreserve.gov/monetarypolicy/fomcminutes20261028.htm"]);
  });

  it("does not accept a strong source that does not repeat the fact's numbers", async () => {
    const { confirmsFact, factSignals } = await import("../../examples/evidence-starter/primary-source.js");
    const signals = factSignals("Nigeria's inflation fell to 14.06% in October", "");

    expect(confirmsFact("Nigeria's inflation fell to 15.10% in October", signals)).toBe(false);
    expect(confirmsFact("Nigeria's headline inflation fell to 14.06% in October", signals)).toBe(true);
  });

  it("holds an unrated outlet's fact when nothing confirms it, and records why", async () => {
    const unrated = {
      ...research,
      researches: [
        {
          ...research.researches[0],
          research: {
            ...research.researches[0].research,
            assessments: [
              {
                ...research.researches[0].research.assessments[0],
                source: { ...research.researches[0].research.assessments[0].source, url: "https://aroundprague.cz/x", sourceName: "Around Prague" },
                article: { ...research.researches[0].research.assessments[0].article, finalUrl: "https://aroundprague.cz/x", requestedUrl: "https://aroundprague.cz/x" },
              },
            ],
          },
        },
      ],
    } as typeof research;

    const mining = await mineCandidates({
      research: unrated,
      llm: { model: "fake", callsMade: 0, completeJson: async () => directional },
      criteriaByMarket: new Map(),
      corroborate: async () => null,
      extraction: { now },
      log: () => {},
    });

    expect(mining.candidates).toHaveLength(0);
    expect(mining.findings[0]).toMatchObject({
      status: "needs_primary_source",
      credibility: "unknown",
      reasons: ["Only an unrated outlet reports this; no primary or established source confirmed it"],
    });
  });
});

describe("repeated pages and unstable classifications (live-check regression)", () => {
  // Real case: the same CNBC page arrived twice and was read as context once, NO once.
  const twice = {
    ...research,
    researches: [
      {
        ...research.researches[0],
        research: {
          ...research.researches[0].research,
          assessments: [research.researches[0].research.assessments[0], research.researches[0].research.assessments[0]],
        },
      },
    ],
  } as typeof research;

  const sequence = (replies: unknown[]) => {
    let calls = 0;
    return {
      model: "fake",
      get callsMade() {
        return calls;
      },
      async completeJson() {
        return replies[Math.min(calls++, replies.length - 1)];
      },
    };
  };

  it("reads a page that arrived twice only once", async () => {
    const llm = sequence([directional]);
    const mining = await mineCandidates({ research: twice, llm, criteriaByMarket: new Map(), extraction: { now }, log: () => {} });

    expect(llm.callsMade).toBe(1);
    expect(mining.findings).toHaveLength(1);
  });

  it("holds a directional finding when the second reading disagrees", async () => {
    const llm = sequence([directional, { relationship: "context", rationale: "Background." }]);
    const mining = await mineCandidates({
      research: twice,
      llm,
      criteriaByMarket: new Map(),
      confirmDirectional: true,
      extraction: { now },
      log: () => {},
    });

    expect(mining.candidates).toHaveLength(0);
    expect(mining.findings[0].status).toBe("failed_checks");
    expect(mining.findings[0].reasons[0]).toContain("Second reading disagreed");
  });

  it("keeps a directional finding when both readings agree", async () => {
    const llm = sequence([directional, directional]);
    const mining = await mineCandidates({
      research: twice,
      llm,
      criteriaByMarket: new Map(),
      confirmDirectional: true,
      extraction: { now },
      log: () => {},
    });

    expect(llm.callsMade).toBe(2);
    expect(mining.candidates).toHaveLength(1);
  });
});
