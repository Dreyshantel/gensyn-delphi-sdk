
import type {
  EvidenceEvaluation,
} from "./evidence-research.js";

/**
 * A candidate that has passed the initial evidence-evaluation rules
 * and is waiting for a human approval decision.
 *
 * Pending does not mean approved or submitted.
 */
export interface EvidenceCandidate {
  evaluation: EvidenceEvaluation;
  approvalStatus: "pending";
}

/**
 * A finding excluded from the human approval shortlist.
 */
export interface ExcludedEvidenceCandidate {
  evaluation: EvidenceEvaluation;
  exclusionReason: "duplicate" | "rejected";
}

/**
 * Result of preparing evaluated findings for human review.
 */
export interface EvidenceCandidatePreparationResult {
  totalEvaluated: number;
  eligibleCount: number;
  reviewCount: number;
  excludedCount: number;

  /** Strong, non-duplicate findings awaiting approval. */
  candidates: EvidenceCandidate[];

  /** Non-duplicate findings requiring additional investigation. */
  reviewQueue: EvidenceCandidate[];

  /** Duplicate and rejected findings. */
  excluded: ExcludedEvidenceCandidate[];
}

/**
 * Sorts candidates by their total evidence score in descending order.
 *
 * When scores are equal, their original input order is preserved.
 */
function sortByScore<T extends { evaluation: EvidenceEvaluation }>(
  items: T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const scoreDifference =
        b.item.evaluation.scores.total -
        a.item.evaluation.scores.total;

      return scoreDifference !== 0
        ? scoreDifference
        : a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * Prepares ranked evidence evaluations for human approval.
 *
 * Rules:
 * - Duplicate findings are always excluded.
 * - Findings with a "reject" recommendation are excluded.
 * - Non-duplicate "strong" findings enter the approval shortlist.
 * - Non-duplicate "review" findings enter the review queue.
 *
 * This function does not approve or submit evidence.
 * It only prepares candidates for the next stage of the workflow.
 */
export function prepareEvidenceCandidates(
  evaluations: readonly EvidenceEvaluation[],
): EvidenceCandidatePreparationResult {
  const candidates: EvidenceCandidate[] = [];
  const reviewQueue: EvidenceCandidate[] = [];
  const excluded: ExcludedEvidenceCandidate[] = [];

  for (const evaluation of evaluations) {
    // Duplicate detection takes precedence over the recommendation.
    if (evaluation.duplicate) {
      excluded.push({
        evaluation,
        exclusionReason: "duplicate",
      });

      continue;
    }

    switch (evaluation.recommendation) {
      case "strong":
        candidates.push({
          evaluation,
          approvalStatus: "pending",
        });
        break;

      case "review":
        reviewQueue.push({
          evaluation,
          approvalStatus: "pending",
        });
        break;

      case "reject":
        excluded.push({
          evaluation,
          exclusionReason: "rejected",
        });
        break;
    }
  }

  // Rank each group independently, highest score first.
  const rankedCandidates = sortByScore(candidates);
  const rankedReviewQueue = sortByScore(reviewQueue);

  return {
    totalEvaluated: evaluations.length,
    eligibleCount: rankedCandidates.length,
    reviewCount: rankedReviewQueue.length,
    excludedCount: excluded.length,

    candidates: rankedCandidates,
    reviewQueue: rankedReviewQueue,
    excluded,
  };
}

