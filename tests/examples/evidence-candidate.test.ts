
import { describe, expect, it } from "vitest";

import {
  prepareEvidenceCandidates,
} from "../../examples/evidence-starter/evidence-candidate.js";

import type {
  EvidenceEvaluation,
} from "../../examples/evidence-starter/evidence-research.js";

/**
 * Creates a valid evaluation for testing.
 *
 * Individual tests can override the recommendation, score,
 * duplicate status and other relevant properties.
 */
function createEvaluation(
  overrides: Partial<EvidenceEvaluation> = {},
): EvidenceEvaluation {
  const baseEvaluation: EvidenceEvaluation = {
    finding: {
      marketAddress: "0xmarket123",
      claim: "Nigeria's inflation rate declined in October 2026.",
      sourceUrl: "https://example.com/inflation-report",
      sourceName: "Example News",
      sourceType: "news",
      publishedAt: "2026-11-10T10:00:00.000Z",
      discoveredAt: "2026-11-12T10:00:00.000Z",
      evidenceDate: "2026-10-31T00:00:00.000Z",
      relevanceAssessment: {
        score: 0.9,
        direction: "yes",
        rationale: "The report directly addresses the market question.",
      },
    },

    scores: {
      relevance: 0.9,
      credibility: 0.8,
      novelty: 0.8,
      verifiability: 0.9,
      recency: 0.9,
      total: 0.86,
    },

    duplicate: false,
    reasons: [],
    recommendation: "strong",
  };

  return {
    ...baseEvaluation,
    ...overrides,
    finding: {
      ...baseEvaluation.finding,
      ...overrides.finding,
    },
    scores: {
      ...baseEvaluation.scores,
      ...overrides.scores,
    },
  };
}

describe("evidence candidate preparation", () => {
  it("returns empty groups when there are no evaluations", () => {
    const result = prepareEvidenceCandidates([]);

    expect(result.totalEvaluated).toBe(0);
    expect(result.eligibleCount).toBe(0);
    expect(result.reviewCount).toBe(0);
    expect(result.excludedCount).toBe(0);

    expect(result.candidates).toEqual([]);
    expect(result.reviewQueue).toEqual([]);
    expect(result.excluded).toEqual([]);
  });

  it("places strong non-duplicate findings in the approval shortlist", () => {
    const evaluation = createEvaluation({
      recommendation: "strong",
      duplicate: false,
    });

    const result = prepareEvidenceCandidates([evaluation]);

    expect(result.candidates).toHaveLength(1);
    expect(result.reviewQueue).toHaveLength(0);
    expect(result.excluded).toHaveLength(0);

    expect(result.candidates[0].evaluation).toBe(evaluation);
    expect(result.candidates[0].approvalStatus).toBe("pending");
  });

  it("places review findings in the review queue", () => {
    const evaluation = createEvaluation({
      recommendation: "review",
      scores: {
        total: 0.62,
      },
    });

    const result = prepareEvidenceCandidates([evaluation]);

    expect(result.candidates).toHaveLength(0);
    expect(result.reviewQueue).toHaveLength(1);
    expect(result.excluded).toHaveLength(0);

    expect(result.reviewQueue[0].evaluation).toBe(evaluation);
    expect(result.reviewQueue[0].approvalStatus).toBe("pending");
  });

  it("excludes findings with a reject recommendation", () => {
    const evaluation = createEvaluation({
      recommendation: "reject",
      reasons: ["Evidence relevance is too weak."],
    });

    const result = prepareEvidenceCandidates([evaluation]);

    expect(result.candidates).toHaveLength(0);
    expect(result.reviewQueue).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);

    expect(result.excluded[0].evaluation).toBe(evaluation);
    expect(result.excluded[0].exclusionReason).toBe("rejected");
  });

  it("excludes duplicate findings even when their recommendation is strong", () => {
    const evaluation = createEvaluation({
      recommendation: "strong",
      duplicate: true,
    });

    const result = prepareEvidenceCandidates([evaluation]);

    expect(result.candidates).toHaveLength(0);
    expect(result.reviewQueue).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);

    expect(result.excluded[0].exclusionReason).toBe("duplicate");
  });

  it("excludes duplicate findings even when their recommendation is review", () => {
    const evaluation = createEvaluation({
      recommendation: "review",
      duplicate: true,
    });

    const result = prepareEvidenceCandidates([evaluation]);

    expect(result.reviewQueue).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].exclusionReason).toBe("duplicate");
  });

  it("sorts eligible candidates by total score in descending order", () => {
    const low = createEvaluation({
      finding: {
        claim: "Lower-scoring claim",
      },
      scores: {
        total: 0.65,
      },
    });

    const high = createEvaluation({
      finding: {
        claim: "Higher-scoring claim",
      },
      scores: {
        total: 0.95,
      },
    });

    const middle = createEvaluation({
      finding: {
        claim: "Middle-scoring claim",
      },
      scores: {
        total: 0.8,
      },
    });

    const result = prepareEvidenceCandidates([
      low,
      high,
      middle,
    ]);

    expect(
      result.candidates.map(
        (candidate) => candidate.evaluation.finding.claim,
      ),
    ).toEqual([
      "Higher-scoring claim",
      "Middle-scoring claim",
      "Lower-scoring claim",
    ]);
  });

  it("preserves input order when candidate scores are equal", () => {
    const first = createEvaluation({
      finding: {
        claim: "First claim",
      },
      scores: {
        total: 0.8,
      },
    });

    const second = createEvaluation({
      finding: {
        claim: "Second claim",
      },
      scores: {
        total: 0.8,
      },
    });

    const third = createEvaluation({
      finding: {
        claim: "Third claim",
      },
      scores: {
        total: 0.8,
      },
    });

    const result = prepareEvidenceCandidates([
      first,
      second,
      third,
    ]);

    expect(
      result.candidates.map(
        (candidate) => candidate.evaluation.finding.claim,
      ),
    ).toEqual([
      "First claim",
      "Second claim",
      "Third claim",
    ]);
  });

  it("sorts the review queue independently", () => {
    const low = createEvaluation({
      recommendation: "review",
      finding: {
        claim: "Review claim with lower score",
      },
      scores: {
        total: 0.45,
      },
    });

    const high = createEvaluation({
      recommendation: "review",
      finding: {
        claim: "Review claim with higher score",
      },
      scores: {
        total: 0.7,
      },
    });

    const result = prepareEvidenceCandidates([
      low,
      high,
    ]);

    expect(
      result.reviewQueue.map(
        (candidate) => candidate.evaluation.finding.claim,
      ),
    ).toEqual([
      "Review claim with higher score",
      "Review claim with lower score",
    ]);
  });

  it("correctly reports counts for mixed evaluations", () => {
    const evaluations = [
      createEvaluation({
        recommendation: "strong",
      }),
      createEvaluation({
        recommendation: "review",
        scores: {
          total: 0.6,
        },
      }),
      createEvaluation({
        recommendation: "reject",
      }),
      createEvaluation({
        recommendation: "strong",
        duplicate: true,
      }),
      createEvaluation({
        recommendation: "strong",
      }),
    ];

    const result = prepareEvidenceCandidates(evaluations);

    expect(result.totalEvaluated).toBe(5);
    expect(result.eligibleCount).toBe(2);
    expect(result.reviewCount).toBe(1);
    expect(result.excludedCount).toBe(2);

    expect(result.candidates).toHaveLength(2);
    expect(result.reviewQueue).toHaveLength(1);
    expect(result.excluded).toHaveLength(2);
  });

  it("does not mutate the original evaluations array", () => {
    const first = createEvaluation({
      scores: {
        total: 0.6,
      },
    });

    const second = createEvaluation({
      scores: {
        total: 0.9,
      },
    });

    const evaluations = [first, second];
    const originalOrder = [...evaluations];

    prepareEvidenceCandidates(evaluations);

    expect(evaluations).toEqual(originalOrder);
    expect(evaluations[0]).toBe(first);
    expect(evaluations[1]).toBe(second);
  });

  it("preserves the original evaluation details", () => {
    const evaluation = createEvaluation({
      finding: {
        claim: "The underlying evidence claim.",
        sourceName: "Official Statistics Publisher",
        sourceUrl: "https://example.com/official-report",
      },
      reasons: ["Requires human confirmation."],
    });

    const result = prepareEvidenceCandidates([evaluation]);

    expect(result.candidates[0].evaluation.finding.claim)
      .toBe("The underlying evidence claim.");

    expect(result.candidates[0].evaluation.finding.sourceName)
      .toBe("Official Statistics Publisher");

    expect(result.candidates[0].evaluation.finding.sourceUrl)
      .toBe("https://example.com/official-report");

    expect(result.candidates[0].evaluation.reasons)
      .toEqual(["Requires human confirmation."]);
  });
});

