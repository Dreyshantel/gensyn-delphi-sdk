/**
 * Decides whether one evidence candidate may be submitted.
 *
 * `checkEligibility` is a pure function: it reads a candidate and the
 * facts the runner gathered (history, account submissions, API limits)
 * and returns every reason the candidate is blocked. An empty list means
 * eligible. Keeping it pure makes each competition rule testable:
 *
 *   - the evidence cutoff is the submission deadline,
 *   - at most 3 submissions per market,
 *   - repeats earn nothing ("it's the facts that count", not the URL),
 *   - evidence for both sides of a market cancels out,
 *   - only real, quoted, dated evidence (no unsupported YES/NO).
 */

import type { EvidenceDirection } from "./evidence-assessor.js";
import type { SubmissionRecord } from "./submission-history.js";

export interface SubmissionCandidate {
  marketAddress: string;
  marketQuestion: string;
  marketStatus: string;
  evidenceCutoffAt: string;
  /** Omitted when no one has established YES or NO. */
  direction?: EvidenceDirection;
  fact: string;
  asOfDate: string;
  quote: string;
  sourceUrl: string;
  publisher: string;
  publishedAt?: string;
  rationale: string;
  /** 0..1. */
  confidence: number;
}

export interface EligibilityContext {
  now: number;
  /** This agent's local records for the candidate's market. */
  history: SubmissionRecord[];
  /** Notes already submitted to this market by the account (any agent), from listSubmissions. */
  accountNotes: string[];
  /** From EvidenceClient.getEntryState, when fetched. */
  entryState?: {
    canSubmit: boolean;
    remainingOnMarket: number;
    reason?: string;
  };
  /** From EvidenceClient.getLimits, when fetched. */
  limits?: {
    submitsLeftThisHour: number;
    dailyCapLeft: number;
  };
  /** Minimum candidate confidence. Default 0.6. */
  minConfidence?: number;
  /** Per-market submission cap. Default 3 (competition rule). */
  maxPerMarket?: number;
  /** Fact similarity (0..1) at which a candidate counts as a repeat. Default 0.6. */
  duplicateThreshold?: number;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from",
  "has", "have", "in", "is", "it", "its", "of", "on", "or", "that", "the",
  "their", "this", "to", "was", "were", "will", "with", "said", "says",
  "according", "report", "reported", "source", "published", "of",
]);

/** Content words and numbers of a text, for fact comparison. */
export function factTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2")
    .split(/[^a-z0-9.%]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

  return new Set(tokens);
}

/**
 * Overlap of two facts relative to the shorter one (0..1).
 * Using the shorter side means a short fact contained in a long note
 * still counts as a repeat.
 */
export function factSimilarity(a: string, b: string): number {
  const left = factTokens(a);
  const right = factTokens(b);

  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const token of left) {
    if (right.has(token)) {
      shared++;
    }
  }

  return shared / Math.min(left.size, right.size);
}

/** Statuses after which a submission no longer counts for direction or repeats. */
const DISCARDED_STATUSES = new Set(["rejected", "failed", "unmatched"]);

export function checkEligibility(
  candidate: SubmissionCandidate,
  context: EligibilityContext,
): EligibilityResult {
  const reasons: string[] = [];
  const minConfidence = context.minConfidence ?? 0.6;
  const maxPerMarket = context.maxPerMarket ?? 3;
  const duplicateThreshold = context.duplicateThreshold ?? 0.6;

  // Market state.
  if (candidate.marketStatus.toLowerCase() !== "open") {
    reasons.push(`Market is ${candidate.marketStatus}, not open`);
  }

  const cutoff = Date.parse(candidate.evidenceCutoffAt);

  if (!Number.isFinite(cutoff) || cutoff <= context.now) {
    reasons.push("The market's evidence cutoff (submission deadline) has passed");
  }

  // Evidence quality.
  if (candidate.direction === undefined) {
    reasons.push("No YES/NO direction has been established");
  }

  if (!candidate.quote.trim()) {
    reasons.push("No verbatim source quote");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate.asOfDate)) {
    reasons.push("The fact has no as-of date");
  }

  if (!(candidate.confidence >= minConfidence)) {
    reasons.push(
      `Confidence ${candidate.confidence.toFixed(2)} is below ${minConfidence.toFixed(2)}`,
    );
  }

  try {
    const url = new URL(candidate.sourceUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error();
    }
  } catch {
    reasons.push("Source URL is not a valid http(s) URL");
  }

  // Per-market history.
  const live = context.history.filter(
    (record) => !DISCARDED_STATUSES.has(record.status),
  );

  // A submit Delphi refused outright (no submission id) never used a slot.
  const usedSlots = context.history.filter(
    (record) => !(record.status === "failed" && !record.submissionId),
  ).length;

  if (usedSlots >= maxPerMarket) {
    reasons.push(`Already used ${usedSlots} of ${maxPerMarket} submissions on this market`);
  }

  if (candidate.direction !== undefined) {
    const opposite = live.find((record) => record.direction !== candidate.direction);

    if (opposite) {
      reasons.push(
        `An earlier submission on this market points ${opposite.direction.toUpperCase()}; evidence for both sides cancels out`,
      );
    }
  }

  if (
    context.history.some(
      (record) => record.sourceUrl === candidate.sourceUrl,
    )
  ) {
    reasons.push("This source was already submitted to this market");
  }

  const previousFacts = [
    ...live.map((record) => record.fact),
    ...context.accountNotes,
  ];

  const repeat = previousFacts.find(
    (previous) => factSimilarity(candidate.fact, previous) >= duplicateThreshold,
  );

  if (repeat !== undefined) {
    reasons.push("The fact repeats one already submitted to this market");
  }

  // API state, when known.
  if (context.entryState) {
    if (!context.entryState.canSubmit) {
      reasons.push(
        `Delphi will not accept a submission: ${context.entryState.reason ?? "cannot submit"}`,
      );
    } else if (context.entryState.remainingOnMarket <= 0) {
      reasons.push("No submissions left on this market (Delphi)");
    }
  }

  if (context.limits) {
    if (context.limits.submitsLeftThisHour <= 0) {
      reasons.push("Hourly submission limit reached");
    }

    if (context.limits.dailyCapLeft <= 0) {
      reasons.push("Daily submission cap reached");
    }
  }

  return { eligible: reasons.length === 0, reasons };
}
