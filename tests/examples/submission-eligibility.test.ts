import { describe, expect, it } from "vitest";

import {
  checkEligibility,
  factSimilarity,
  type EligibilityContext,
  type SubmissionCandidate,
} from "../../examples/evidence-starter/submission-eligibility.js";

import type { SubmissionRecord } from "../../examples/evidence-starter/submission-history.js";

const now = Date.parse("2026-11-25T12:00:00Z");

const candidate: SubmissionCandidate = {
  marketAddress: "0xAbC",
  marketQuestion: "Will X happen?",
  marketStatus: "open",
  evidenceCutoffAt: "2026-12-10T17:00:00Z",
  direction: "yes",
  fact: "The regulator approved the merger on 20 November 2026 with no conditions attached.",
  asOfDate: "2026-11-20",
  quote: "approved the merger with no conditions",
  sourceUrl: "https://regulator.example/decision",
  publisher: "Regulator",
  rationale: "Approval is the resolution condition.",
  confidence: 0.8,
};

const context: EligibilityContext = { now, history: [], accountNotes: [] };

function record(patch: Partial<SubmissionRecord> = {}): SubmissionRecord {
  return {
    idempotencyKey: Math.random().toString(36),
    marketAddress: "0xabc",
    marketQuestion: "Will X happen?",
    direction: "yes",
    fact: "Unrelated earlier fact about shipping volumes in October.",
    asOfDate: "2026-11-01",
    sourceUrl: "https://other.example/a",
    publisher: "Other",
    note: "",
    links: [],
    status: "judged",
    createdAt: "",
    updatedAt: "",
    attempts: 1,
    ...patch,
  };
}

const reasonsFor = (c: Partial<SubmissionCandidate>, ctx: Partial<EligibilityContext> = {}) =>
  checkEligibility({ ...candidate, ...c }, { ...context, ...ctx }).reasons;

describe("checkEligibility", () => {
  it("accepts a complete, new candidate", () => {
    expect(checkEligibility(candidate, context)).toEqual({ eligible: true, reasons: [] });
  });

  it("blocks a candidate without a direction", () => {
    expect(reasonsFor({ direction: undefined })).toContain("No YES/NO direction has been established");
  });

  it("blocks a market past its cutoff, which is the submission deadline", () => {
    expect(reasonsFor({ evidenceCutoffAt: "2026-11-25T11:00:00Z" })[0]).toContain("cutoff");
  });

  it("blocks a closed market", () => {
    expect(reasonsFor({ marketStatus: "awaiting_settlement" })[0]).toContain("not open");
  });

  it("blocks low confidence", () => {
    expect(reasonsFor({ confidence: 0.3 })[0]).toContain("below 0.60");
  });

  it("blocks a missing quote, date or bad URL", () => {
    const reasons = reasonsFor({ quote: " ", asOfDate: "", sourceUrl: "ftp://x" });

    expect(reasons).toEqual(
      expect.arrayContaining([
        "No verbatim source quote",
        "The fact has no as-of date",
        "Source URL is not a valid http(s) URL",
      ]),
    );
  });

  it("enforces 3 submissions per market", () => {
    const history = [record(), record(), record()];

    expect(reasonsFor({}, { history })[0]).toContain("3 of 3");
  });

  it("does not count a refused submit that never landed as a used slot", () => {
    const history = [record(), record(), record({ status: "failed", submissionId: undefined })];

    expect(reasonsFor({}, { history })).toEqual([]);
  });

  it("blocks evidence for the opposite side of an earlier submission", () => {
    const reasons = reasonsFor({ direction: "no" }, { history: [record({ direction: "yes" })] });

    expect(reasons.join(" ")).toContain("cancels out");
  });

  it("ignores the direction of a rejected submission", () => {
    expect(
      reasonsFor({ direction: "no" }, { history: [record({ direction: "yes", status: "rejected" })] }),
    ).toEqual([]);
  });

  it("blocks a repeat of a fact we already submitted", () => {
    const history = [
      record({ fact: "On 20 November 2026 the regulator approved the merger, attaching no conditions." }),
    ];

    expect(reasonsFor({}, { history })).toContain("The fact repeats one already submitted to this market");
  });

  it("blocks a repeat found in the account's submissions from another agent", () => {
    const accountNotes = [
      "As of 2026-11-20: The regulator approved the merger with no conditions attached.",
    ];

    expect(reasonsFor({}, { accountNotes })).toContain(
      "The fact repeats one already submitted to this market",
    );
  });

  it("blocks reusing a source already submitted to the market", () => {
    const history = [record({ sourceUrl: candidate.sourceUrl })];

    expect(reasonsFor({}, { history })).toContain("This source was already submitted to this market");
  });

  it("respects Delphi entry state and limits", () => {
    const reasons = reasonsFor(
      {},
      {
        entryState: { canSubmit: false, remainingOnMarket: 0, reason: "restricted" },
        limits: { submitsLeftThisHour: 0, dailyCapLeft: 0 },
      },
    );

    expect(reasons).toEqual([
      "Delphi will not accept a submission: restricted",
      "Hourly submission limit reached",
      "Daily submission cap reached",
    ]);
  });
});

describe("factSimilarity", () => {
  it("is high for the same fact reworded", () => {
    expect(
      factSimilarity(
        "CPI rose to 4.1% in October 2026",
        "In October 2026, CPI rose to 4.1%",
      ),
    ).toBe(1);
  });

  it("is low for different facts", () => {
    expect(
      factSimilarity("CPI rose to 4.1% in October", "The team signed a new striker on Monday"),
    ).toBeLessThan(0.2);
  });

  it("treats different numbers as different facts", () => {
    expect(factSimilarity("CPI rose to 4.1%", "CPI rose to 3.2%")).toBeLessThan(1);
  });
});
