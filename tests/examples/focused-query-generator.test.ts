import { describe, expect, it } from "vitest";

import {
  buildSubject,
  createLlmQueryGenerator,
  extractEntities,
  extractKeyTerms,
  focusedQueryGenerator,
} from "../../examples/evidence-starter/focused-query-generator.js";
import { planResearchQueries } from "../../examples/evidence-starter/research-planner.js";
import type { LlmClient } from "../../examples/evidence-starter/llm-client.js";

const input = {
  marketAddress: "0xabc",
  marketQuestion: "Will the Federal Reserve cut interest rates at its December 2026 meeting?",
  resolutionCriteria: "YES if the FOMC announces a cut at its December 2026 meeting.",
  evidenceCutoffAt: "2026-12-10T17:00:00Z",
  suggestedDataSources: ["Federal Reserve Board"],
};

const now = Date.parse("2026-11-25T12:00:00Z");

function fakeLlm(reply: unknown): LlmClient {
  return {
    model: "fake",
    callsMade: 0,
    async completeJson() {
      if (reply instanceof Error) {
        throw reply;
      }

      return reply;
    },
  };
}

describe("key-term extraction", () => {
  it("drops question words and the deadline but keeps names and thresholds", () => {
    expect(extractKeyTerms("Will Bitcoin close above $150,000 on 31 December 2026?")).toEqual([
      "Bitcoin",
      "close",
      "$150,000",
    ]);
  });

  it("keeps multi-word entities and ignores month names", () => {
    expect(extractEntities(input.marketQuestion)).toEqual(["Federal Reserve"]);
  });

  it("adds topic words to a one-entity subject", () => {
    expect(
      buildSubject("Will Nigeria's annual inflation rate fall below 20 percent by December 2026?"),
    ).toBe("Nigeria annual inflation");
  });
});

describe("focusedQueryGenerator", () => {
  it("produces a valid plan of short keyword queries with a freshness filter", async () => {
    const plan = await planResearchQueries(input, focusedQueryGenerator, now);

    expect(plan.queries.length).toBeGreaterThanOrEqual(3);
    expect(plan.queries.length).toBeLessThanOrEqual(8);
    expect(plan.queries[0].query).toBe("Federal Reserve cut interest rates December 2026 when:7d");
    expect(plan.queries.some((q) => q.query.includes('"Federal Reserve Board"'))).toBe(true);

    for (const q of plan.queries) {
      expect(q.query).not.toContain("?");
      expect(q.query.split(" ").length).toBeLessThanOrEqual(10);
    }
  });
});

describe("createLlmQueryGenerator", () => {
  it("puts the freshness query first, then the LLM's queries", async () => {
    const generator = createLlmQueryGenerator(
      fakeLlm({
        queries: [
          { query: "FOMC December meeting rate decision", objective: "Find the decision.", sourceTypes: ["official"] },
          { query: "CME FedWatch December cut odds", sourceTypes: ["bogus"] },
        ],
      }),
    );

    const plan = await planResearchQueries(input, generator, now);

    expect(plan.queries[0].query).toContain("when:7d");
    expect(plan.queries[1]).toEqual({
      query: "FOMC December meeting rate decision",
      objective: "Find the decision.",
      sourceTypes: ["official"],
    });
    expect(plan.queries[2]).toMatchObject({ query: "CME FedWatch December cut odds", sourceTypes: ["news"] });
    expect(plan.queries.length).toBeLessThanOrEqual(8);
  });

  it("falls back to rule-based queries when the LLM fails", async () => {
    const logs: string[] = [];
    const generator = createLlmQueryGenerator(fakeLlm(new Error("rate limited")), undefined, (m) =>
      logs.push(String(m)),
    );

    const plan = await planResearchQueries(input, generator, now);
    const rules = (await focusedQueryGenerator(input)) as { queries: unknown[] };

    expect(plan.queries).toHaveLength(rules.queries.length);
    expect(logs[0]).toContain("fell back");
  });

  it("drops sentence-length queries from the model", async () => {
    const generator = createLlmQueryGenerator(
      fakeLlm({
        queries: [
          {
            query:
              "will the federal reserve decide to cut interest rates at the meeting that happens in december",
          },
        ],
      }),
    );

    const plan = await planResearchQueries(input, generator, now);

    expect(plan.queries.some((q) => q.query.startsWith("will the federal"))).toBe(false);
  });
});
