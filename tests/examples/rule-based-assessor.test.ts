
import { describe, expect, it } from "vitest";

import {
  assessSupportingStatement,
  classifyEvidenceRelationship,
  ruleBasedEvidenceAssessor,
} from "../../examples/evidence-starter/rule-based-assessor.js";

import type {
  EvidenceAssessmentInput,
} from "../../examples/evidence-starter/evidence-assessor.js";

const baseInput: EvidenceAssessmentInput = {
  marketQuestion:
    "Will Nigeria's inflation rate fall below 20%?",
  resolutionCriteria:
    "The market resolves YES if the officially published annual inflation rate is below 20% before the evidence cutoff.",
  evidenceClaim:
    "Nigeria inflation rate falls to 18.5%",
  sourceExcerpt:
    "The National Bureau of Statistics published its latest inflation report. " +
    "The annual inflation rate fell to 18.5% in the latest report.",
  sourceUrl: "https://example.com/inflation-report",
  evidenceDate: "2026-11-20",
  evidenceCutoffAt: "2026-12-01",
};

describe("rule-based evidence assessor", () => {
  it("identifies relevant terms and returns a relevance score", async () => {
    const result =
      await ruleBasedEvidenceAssessor(baseInput);

    expect(result.relevanceScore).toBeGreaterThan(0);
    expect(result.relevanceScore).toBeLessThanOrEqual(1);
    expect(result.rationale).toContain("relevant");
  });

  it("extracts potentially relevant source statements", async () => {
    const result =
      await ruleBasedEvidenceAssessor(baseInput);

    expect(
      result.supportingStatements.length,
    ).toBeGreaterThan(0);

    expect(
      result.supportingStatements.some((statement) =>
        statement.includes("18.5%"),
      ),
    ).toBe(true);
  });

  it("does not infer YES or NO from keyword overlap", async () => {
    const result =
      await ruleBasedEvidenceAssessor(baseInput);

    expect(result.direction).toBeUndefined();
    expect(result).not.toHaveProperty("direction");
    expect(result.relationship).toBe("direct_support");
  });

  it("returns zero relevance when there is no meaningful overlap", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      evidenceClaim: "A completely unrelated sporting event",
      sourceExcerpt:
        "The football team won its championship after a difficult season.",
    });

    expect(result.relevanceScore).toBe(0);
    expect(result.supportingStatements).toHaveLength(0);
  });

  it("reports its verification limitations", async () => {
    const result =
      await ruleBasedEvidenceAssessor(baseInput);

    expect(result.limitations).toContain(
      "Publisher credibility and source independence have not been verified.",
    );
  });

  it("returns zero relevance when the market has no usable target terms", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      marketQuestion: "What is it?",
      resolutionCriteria: "This is the market.",
      evidenceClaim: "An unrelated article",
      sourceExcerpt: "An unrelated article with no matching terms.",
    });

    expect(result.relevanceScore).toBe(0);
    expect(result.supportingStatements).toHaveLength(0);
  });

  it("reduces relevance for foreign-only evidence", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      evidenceClaim:
        "US inflation rate falls after Federal Reserve policy changes",
      sourceExcerpt:
        "The Federal Reserve reported that the annual US inflation rate fell to 2.5%.",
    });

    expect(result.relevanceScore).toBeGreaterThan(0);
    expect(result.relevanceScore).toBeLessThan(1);
    expect(result.rationale).toContain("jurisdiction mismatch");
    expect(result.rationale).toContain("50%");
  });

  it("does not penalise evidence that directly mentions Nigeria", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      evidenceClaim:
        "Nigeria inflation rate falls as global prices ease",
      sourceExcerpt:
        "The Federal Reserve discussed global inflation trends. " +
        "Nigeria's annual inflation rate fell to 18.5%, according to the latest report.",
    });

    expect(result.rationale).not.toContain("jurisdiction mismatch");
    expect(result.relevanceScore).toBeGreaterThan(0);
  });

  it("does not penalise international evidence without a foreign-country mismatch", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      evidenceClaim:
        "IMF discusses global inflation trends",
      sourceExcerpt:
        "The International Monetary Fund reported that global inflation is easing as food and energy prices stabilise.",
    });

    expect(result.rationale).not.toContain("jurisdiction mismatch");
    expect(result.relevanceScore).toBeGreaterThan(0);
  });

  it("does not apply a jurisdiction penalty when the market has no identifiable country", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      marketQuestion: "Will global inflation fall below 3%?",
      resolutionCriteria:
        "The market resolves YES if global inflation falls below 3%.",
      evidenceClaim:
        "US inflation rate falls below expectations",
      sourceExcerpt:
        "The Federal Reserve reported that annual inflation fell to 2.5%.",
    });

    expect(result.rationale).not.toContain("jurisdiction mismatch");
  });

  it("does not penalise a foreign article that explicitly connects its findings to Nigeria", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      evidenceClaim:
        "US monetary policy could affect Nigeria's inflation outlook",
      sourceExcerpt:
        "The Federal Reserve changed interest rates. " +
        "Economists said the decision could affect Nigeria's exchange rate and inflation outlook.",
    });

    expect(result.rationale).not.toContain("jurisdiction mismatch");
    expect(result.relevanceScore).toBeGreaterThan(0);
  });

  it("excludes unrelated article fragments and metadata", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      sourceExcerpt: [
        "The annual inflation rate fell to 18.5% in the latest report.",
        "Send a tip to our newsroom using the contact form.",
        "The photographer captured the event during the morning session.",
        "Related articles discuss football and international entertainment.",
      ].join(" "),
    });

    expect(result.supportingStatements).toContain(
      "The annual inflation rate fell to 18.5% in the latest report.",
    );

    expect(
      result.supportingStatements.some((statement) =>
        /send a tip|photographer|related articles/i.test(statement),
      ),
    ).toBe(false);
  });

  it("does not retain a sentence based on only one matching term", async () => {
    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      sourceExcerpt:
        "The inflation report was discussed during a separate sporting event.",
    });

    expect(result.supportingStatements).toHaveLength(0);
  });

  it("retains a directly relevant sentence alongside unrelated content", async () => {
    const relevant =
      "The annual inflation rate fell to 18.5% in the latest report.";

    const result = await ruleBasedEvidenceAssessor({
      ...baseInput,
      sourceExcerpt: [
        "The football team won its championship after a difficult season.",
        relevant,
        "Subscribe to receive more updates from our newsroom.",
      ].join(" "),
    });

    expect(result.supportingStatements).toContain(relevant);
    expect(result.supportingStatements).toHaveLength(1);
  });
});

describe("supporting statement assessment", () => {
  const question =
    "Will Nigeria's annual inflation rate fall below 20 percent?";

  const criteria =
    "YES if the officially published annual inflation rate is below 20 percent.";

  it("accepts a directly relevant statement", () => {
    const result = assessSupportingStatement(
      question,
      criteria,
      "The annual inflation rate fell to 18.5% in the latest report.",
    );

    expect(result.isRelevant).toBe(true);
    expect(result.relevanceScore).toBeGreaterThan(0);
  });

  it("rejects unrelated photographer metadata", () => {
    const result = assessSupportingStatement(
      question,
      criteria,
      "The photographer captured the event during the morning session.",
    );

    expect(result.isRelevant).toBe(false);
    expect(result.relevanceScore).toBe(0);
  });

  it("rejects statements with insufficient keyword overlap", () => {
    const result = assessSupportingStatement(
      question,
      criteria,
      "The inflation report was discussed during a separate sporting event.",
    );

    expect(result.isRelevant).toBe(false);
  });

  it("returns matched terms and an explanatory rationale", () => {
    const result = assessSupportingStatement(
      question,
      criteria,
      "The annual inflation rate fell to 18.5% in the latest report.",
    );

    expect(result.matchedTerms.length).toBeGreaterThanOrEqual(2);
    expect(result.rationale).toContain("independently matched");
  });
});

