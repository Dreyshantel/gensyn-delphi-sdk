import { describe, expect, it } from "vitest";

import {
  extractFact,
  quoteAppearsIn,
  validateExtraction,
  type FactExtractionInput,
} from "../../examples/evidence-starter/fact-extractor.js";

import {
  LlmBudgetExceededError,
  type LlmClient,
} from "../../examples/evidence-starter/llm-client.js";

const now = Date.parse("2026-11-25T12:00:00Z");

const input: FactExtractionInput = {
  marketQuestion: "Will the central bank cut its policy rate at the December 2026 meeting?",
  resolutionCriteria: "YES if the bank announces a cut at its December 2026 meeting.",
  evidenceCutoffAt: "2026-12-10T17:00:00Z",
  yesProbability: 0.45,
  article: {
    url: "https://news.example/rates",
    title: "Governor signals pause",
    publisher: "Example News",
    publishedAt: "2026-11-21T09:00:00Z",
    content:
      "On Thursday the governor said “the committee sees no case for a cut this year,” " +
      "according to minutes released on 20 November 2026. Inflation rose to 4.1% in October.",
  },
};

const goodReply = {
  hasFact: true,
  fact: "The governor said on 20 November 2026 that the committee sees no case for a rate cut this year.",
  asOfDate: "2026-11-20",
  direction: "no",
  quote: '"the committee sees no case for a cut this year,"',
  rationale: "A stated no-cut stance directly lowers the chance of a December cut.",
  confidence: 0.8,
};

function fakeLlm(reply: unknown | Error): LlmClient {
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

describe("quoteAppearsIn", () => {
  it("matches despite curly quotes and whitespace", () => {
    expect(quoteAppearsIn("the committee sees no case  for a cut", input.article.content)).toBe(true);
  });

  it("rejects text that is not in the article", () => {
    expect(quoteAppearsIn("the committee will cut rates in December", input.article.content)).toBe(false);
  });

  it("rejects quotes too short to be meaningful", () => {
    expect(quoteAppearsIn("the", input.article.content)).toBe(false);
  });
});

describe("validateExtraction", () => {
  it("accepts a grounded, dated fact", () => {
    const result = validateExtraction(goodReply, input, now);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.fact.direction).toBe("no");
      expect(result.fact.asOfDate).toBe("2026-11-20");
      expect(result.fact.confidence).toBe(0.8);
    }
  });

  it("rejects a quote the article does not contain", () => {
    const result = validateExtraction(
      { ...goodReply, quote: "the committee will certainly cut in December" },
      input,
      now,
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("does not appear verbatim"),
    });
  });

  it("passes through the model's reason when there is no fact", () => {
    expect(validateExtraction({ hasFact: false, reason: "only background" }, input, now)).toEqual({
      ok: false,
      reason: "No usable fact: only background",
    });
  });

  it.each([
    ["an invalid direction", { direction: "neutral" }, "Direction must be yes or no"],
    ["a missing date", { asOfDate: "November" }, "asOfDate must be YYYY-MM-DD"],
    ["a future date", { asOfDate: "2026-11-30" }, "asOfDate is in the future"],
    ["a date after publication", { asOfDate: "2026-11-24" }, "after the article was published"],
    ["a fact that is too short", { fact: "No cut." }, "too short"],
  ])("rejects %s", (_label, patch, reason) => {
    const result = validateExtraction({ ...goodReply, ...patch }, input, now);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.reason).toContain(reason);
    }
  });

  it("rejects a date after the market cutoff", () => {
    const result = validateExtraction(
      { ...goodReply, asOfDate: "2026-11-20" },
      { ...input, evidenceCutoffAt: "2026-11-19T00:00:00Z", article: { ...input.article, publishedAt: undefined } },
      now,
    );

    expect(result).toEqual({ ok: false, reason: "asOfDate is after the market cutoff" });
  });

  it("clamps confidence into 0..1 and defaults a missing one to 0", () => {
    const high = validateExtraction({ ...goodReply, confidence: 7 }, input, now);
    const missing = validateExtraction({ ...goodReply, confidence: undefined }, input, now);

    expect(high.ok && high.fact.confidence).toBe(1);
    expect(missing.ok && missing.fact.confidence).toBe(0);
  });

  it("rejects a non-object reply", () => {
    expect(validateExtraction(["x"], input, now).ok).toBe(false);
  });
});

describe("extractFact", () => {
  it("returns a validated fact from the model", async () => {
    const result = await extractFact(fakeLlm(goodReply), input, { now });

    expect(result.ok).toBe(true);
  });

  it("turns an ordinary LLM failure into a non-fatal result", async () => {
    const result = await extractFact(fakeLlm(new Error("network down")), input, { now });

    expect(result).toEqual({ ok: false, reason: "network down" });
  });

  it("rethrows a budget error so the run stops", async () => {
    await expect(
      extractFact(fakeLlm(new LlmBudgetExceededError(5)), input, { now }),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });
});
