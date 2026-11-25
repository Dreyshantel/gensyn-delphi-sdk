import type { EvidenceRelationship } from "./evidence-assessor.js";
import type { DiscoveredMarket } from "./market-discovery.js";

export type EvidenceSourceType =
  | "official"
  | "regulatory"
  | "academic"
  | "news"
  | "other";

export type EvidenceDirection = "yes" | "no";

export interface RelevanceAssessment {
  score: number;
  direction?: EvidenceDirection;
  rationale: string;
  relationship?: EvidenceRelationship;
}

export interface ResearchFinding {
  marketAddress: string;
  claim: string;
  sourceUrl: string;
  sourceName: string;
  sourceType: EvidenceSourceType;
  publishedAt: string;
  discoveredAt: string;
  /**
   * When the reported event occurred.
   * Omit this when no event date could be extracted.
   * Do not copy `publishedAt` into this field.
   */
  evidenceDate?: string;
  noveltyScore?: number;
  relevanceAssessment?: RelevanceAssessment;
}

export interface KnownClaim {
  claim: string;
  marketAddress?: string;
  sourceUrl?: string;
}

export interface EvidenceScores {
  relevance: number;
  credibility: number;
  novelty: number;
  verifiability: number;
  recency: number;
  total: number;
}

export interface EvidenceEvaluation {
  finding: ResearchFinding;
  scores: EvidenceScores;
  duplicate: boolean;
  reasons: string[];
  recommendation: "strong" | "review" | "reject";
  relevanceAssessment?: RelevanceAssessment;
}

export interface EvidenceResearchOptions {
  now?: number;
  knownClaims?: KnownClaim[];
  relevance: Record<string, number>;
  credibility: Record<EvidenceSourceType, number>;
  verifiability: Record<string, number>;
  weights?: Partial<Omit<EvidenceScores, "total">>;
}

const DEFAULT_WEIGHTS = {
  relevance: 0.30,
  credibility: 0.25,
  novelty: 0.20,
  verifiability: 0.15,
  recency: 0.10,
};

const VALID_SOURCE_TYPES: EvidenceSourceType[] = [
  "official",
  "regulatory",
  "academic",
  "news",
  "other",
];

const VALID_DIRECTIONS: EvidenceDirection[] = [
  "yes",
  "no",
];

const VALID_RELATIONSHIPS: EvidenceRelationship[] = [
  "direct_support",
  "contradiction",
  "context",
  "irrelevant",
  "inconclusive",
];

const FUZZY_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "were",
  "was",
  "are",
  "has",
  "have",
  "had",
  "its",
  "into",
  "over",
  "under",
  "after",
  "before",
  "about",
  "their",
  "they",
  "them",
]);

const TRACKING_PARAMETER =
  /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i;

const DAY_IN_MS = 24 * 60 * 60 * 1000;

function validateScore(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}

function parseDate(name: string, value: string): number {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${name} date`);
  }

  return timestamp;
}

function normaliseClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validateFinding(
  finding: ResearchFinding,
  market: DiscoveredMarket,
  now: number,
): void {
  if (
    typeof finding.claim !== "string" ||
    !finding.claim.trim()
  ) {
    throw new Error("Finding claim cannot be empty");
  }

  if (
    typeof finding.sourceName !== "string" ||
    !finding.sourceName.trim()
  ) {
    throw new Error("Finding source name cannot be empty");
  }

  if (
    typeof finding.marketAddress !== "string" ||
    !finding.marketAddress.trim()
  ) {
    throw new Error("Finding market address cannot be empty");
  }

  if (typeof finding.sourceUrl !== "string") {
    throw new Error(
      "Finding must have a valid HTTP or HTTPS source URL",
    );
  }

  try {
    const url = new URL(finding.sourceUrl);

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "Finding must have a valid HTTP or HTTPS source URL",
    );
  }

  if (!VALID_SOURCE_TYPES.includes(finding.sourceType)) {
    throw new Error("Invalid evidence source type");
  }

  const publishedAt = parseDate(
    "publishedAt",
    finding.publishedAt,
  );

  const discoveredAt = parseDate(
    "discoveredAt",
    finding.discoveredAt,
  );

  const evidenceDate =
    finding.evidenceDate === undefined
      ? undefined
      : parseDate("evidenceDate", finding.evidenceDate);

  const cutoff = parseDate(
    "market evidence cutoff",
    market.evidenceCutoffAt,
  );

  // Validate the market cutoff first. This ensures evidence
  // outside the permitted window gets the specific cutoff error.
  if (publishedAt > cutoff) {
    throw new Error(
      "Finding publication date is after the market evidence cutoff",
    );
  }

  if (discoveredAt > cutoff) {
    throw new Error(
      "Finding discovery date is after the market evidence cutoff",
    );
  }

  if (evidenceDate !== undefined && evidenceDate > cutoff) {
    throw new Error(
      "Finding evidence date is after the market evidence cutoff",
    );
  }

  // Reject dates that are in the future relative to the current time.
  if (publishedAt > now) {
    throw new Error(
      "Finding publication date cannot be in the future",
    );
  }

  if (discoveredAt > now) {
    throw new Error(
      "Finding discovery date cannot be in the future",
    );
  }

  if (evidenceDate !== undefined && evidenceDate > now) {
    throw new Error(
      "Finding evidence date cannot be in the future",
    );
  }

  if (
    evidenceDate !== undefined &&
    evidenceDate > publishedAt
  ) {
    throw new Error(
      "Finding evidence date cannot be after its publication date",
    );
  }

  if (finding.noveltyScore !== undefined) {
    validateScore("Novelty", finding.noveltyScore);
  }

  if (finding.relevanceAssessment !== undefined) {
    const assessment = finding.relevanceAssessment;

    validateScore("Relevance", assessment.score);

    if (
      assessment.direction !== undefined &&
      !VALID_DIRECTIONS.includes(assessment.direction)
    ) {
      throw new Error("Invalid evidence direction");
    }

    if (
      assessment.relationship !== undefined &&
      !VALID_RELATIONSHIPS.includes(assessment.relationship)
    ) {
      throw new Error("Invalid evidence relationship");
    }

    if (
      typeof assessment.rationale !== "string" ||
      !assessment.rationale.trim()
    ) {
      throw new Error("Relevance rationale cannot be empty");
    }
  }
}

export function calculateRecency(
  publishedAt: string,
  now: number,
): number {
  if (!Number.isFinite(now)) {
    throw new Error("Current time must be a valid timestamp");
  }

  const publicationTime = parseDate(
    "publication",
    publishedAt,
  );

  if (publicationTime > now) {
    throw new Error("Publication date cannot be in the future");
  }

  const ageMs = now - publicationTime;
  const ageDays = ageMs / DAY_IN_MS;

  // Exponential decay: newer evidence receives a higher score.
  // The decay constant is 90 days.
  return Math.exp(-ageDays / 90);
}

function claimTokens(claim: string): Set<string> {
  return new Set(
    normaliseClaim(claim)
      .split(" ")
      .filter(
        (token) =>
          token.length >= 3 && !FUZZY_STOP_WORDS.has(token),
      ),
  );
}

function tokenOverlap(
  left: Set<string>,
  right: Set<string>,
): { jaccard: number; containment: number } {
  let intersection = 0;

  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = left.size + right.size - intersection;
  const shorter = Math.min(left.size, right.size);

  return {
    jaccard: union === 0 ? 0 : intersection / union,
    containment: shorter === 0 ? 0 : intersection / shorter,
  };
}

function canonicaliseUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);

    url.hash = "";
    url.hostname = url.hostname
      .toLowerCase()
      .replace(/^www\./, "");

    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETER.test(key)) {
        url.searchParams.delete(key);
      }
    }

    url.searchParams.sort();

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.toString();
  } catch {
    return sourceUrl.trim().toLowerCase();
  }
}

function claimsMatch(
  finding: ResearchFinding,
  known: KnownClaim,
): boolean {
  if (normaliseClaim(finding.claim) === normaliseClaim(known.claim)) {
    return true;
  }

  const findingTokens = claimTokens(finding.claim);
  const knownTokens = claimTokens(known.claim);
  const overlap = tokenOverlap(findingTokens, knownTokens);
  const shorter = Math.min(findingTokens.size, knownTokens.size);

  if (
    shorter >= 6 &&
    (overlap.jaccard >= 0.85 || overlap.containment >= 0.92)
  ) {
    return true;
  }

  if (
    known.sourceUrl &&
    shorter >= 5 &&
    overlap.jaccard >= 0.6 &&
    canonicaliseUrl(known.sourceUrl) ===
      canonicaliseUrl(finding.sourceUrl)
  ) {
    return true;
  }

  return false;
}

function isDuplicate(
  finding: ResearchFinding,
  knownClaims: KnownClaim[],
): boolean {
  return knownClaims.some((known) => {
    if (
      known.marketAddress &&
      known.marketAddress.toLowerCase() !==
        finding.marketAddress.toLowerCase()
    ) {
      return false;
    }

    return claimsMatch(finding, known);
  });
}

export function evaluateFinding(
  finding: ResearchFinding,
  market: DiscoveredMarket,
  options: EvidenceResearchOptions,
): EvidenceEvaluation {
  const now = options.now ?? Date.now();

  if (!Number.isFinite(now)) {
    throw new Error("Current time must be a valid timestamp");
  }

  validateFinding(finding, market, now);

  if (
    finding.marketAddress.toLowerCase() !==
    market.address.toLowerCase()
  ) {
    throw new Error(
      "Finding does not belong to the supplied market",
    );
  }

  // Finding-level relevance takes priority over market-level fallback.
  // The fallback lookup is case-insensitive to match market validation.
  const marketRelevance =
    options.relevance[finding.marketAddress] ??
    Object.entries(options.relevance).find(
      ([address]) =>
        address.toLowerCase() ===
        finding.marketAddress.toLowerCase(),
    )?.[1];

  const relevance =
    finding.relevanceAssessment?.score ??
    marketRelevance ??
    0;

  const credibility =
    options.credibility[finding.sourceType] ?? 0;

  const verifiability =
    options.verifiability[finding.sourceUrl] ?? 0;

  validateScore("Relevance", relevance);
  validateScore("Credibility", credibility);
  validateScore("Verifiability", verifiability);

  const duplicate = isDuplicate(
    finding,
    options.knownClaims ?? [],
  );

  // An unassessed finding receives a conservative neutral score.
  // A duplicate always receives zero novelty.
  const suppliedNovelty = finding.noveltyScore ?? 0.5;
  const novelty = duplicate ? 0 : suppliedNovelty;

  const recency = calculateRecency(
    finding.publishedAt,
    now,
  );

  const weights = {
    ...DEFAULT_WEIGHTS,
    ...options.weights,
  };

  for (const [name, weight] of Object.entries(weights)) {
    validateScore(`Weight ${name}`, weight);
  }

  const weightTotal = Object.values(weights).reduce(
    (sum, weight) => sum + weight,
    0,
  );

  if (weightTotal <= 0) {
    throw new Error("Evidence weights must have a positive total");
  }

  const total =
    (
      relevance * weights.relevance +
      credibility * weights.credibility +
      novelty * weights.novelty +
      verifiability * weights.verifiability +
      recency * weights.recency
    ) / weightTotal;

  const reasons: string[] = [];

  if (finding.relevanceAssessment === undefined) {
    reasons.push(
      "Finding has not received an explicit relevance assessment",
    );
  }

  if (relevance < 0.5) {
    reasons.push("Finding has weak relevance to the market");
  }

  if (credibility < 0.5) {
    reasons.push("Source credibility needs further verification");
  }

  if (duplicate) {
    reasons.push("Underlying claim has already been recorded");
  }

  if (verifiability < 0.5) {
    reasons.push("Claim needs stronger independent verification");
  }

  if (recency < 0.3) {
    reasons.push("Source may be too old to provide timely evidence");
  }

  if (novelty < 0.5 && !duplicate) {
    reasons.push("Finding may contain previously known information");
  }

  const relationship = finding.relevanceAssessment?.relationship;
  const direction = finding.relevanceAssessment?.direction;

  if (finding.evidenceDate === undefined) {
    reasons.push(
      "Evidence date was not extracted separately from the publication date",
    );
  }

  if (relationship === "irrelevant") {
    reasons.push("Evidence was assessed as irrelevant to the market");
  } else if (relationship === "context") {
    reasons.push(
      "Evidence provides context but does not resolve the market",
    );
  } else if (relationship === "inconclusive") {
    reasons.push("Evidence is inconclusive for the market outcome");
  }

  if (direction === undefined) {
    reasons.push(
      "Evidence direction has not been established as YES or NO",
    );
  }

  // A high numerical score alone is insufficient for a strong
  // recommendation. An explicit relevance assessment, a separate
  // evidence date, and a resolved support or contradiction label
  // are all required.
  const hasExplicitAssessment =
    finding.relevanceAssessment !== undefined;

  const relationshipAllowsStrong =
    relationship === undefined
      ? direction !== undefined
      : (relationship === "direct_support" && direction === "yes") ||
        (relationship === "contradiction" && direction === "no");

  const meetsStrongCriteria =
    hasExplicitAssessment &&
    finding.evidenceDate !== undefined &&
    relationshipAllowsStrong &&
    !duplicate &&
    relevance >= 0.5 &&
    credibility >= 0.5 &&
    verifiability >= 0.5 &&
    novelty >= 0.5 &&
    total >= 0.75;

  const recommendation =
    duplicate ||
    relevance < 0.3 ||
    credibility < 0.3 ||
    relationship === "irrelevant"
      ? "reject"
      : meetsStrongCriteria
        ? "strong"
        : "review";

  return {
    finding,
    scores: {
      relevance,
      credibility,
      novelty,
      verifiability,
      recency,
      total,
    },
    duplicate,
    reasons,
    recommendation,
    relevanceAssessment: finding.relevanceAssessment,
  };
}

export function rankFindings(
  findings: ResearchFinding[],
  market: DiscoveredMarket,
  options: EvidenceResearchOptions,
): EvidenceEvaluation[] {
  const preliminary = findings
    .map((finding, index) => ({
      finding,
      index,
      evaluation: evaluateFinding(finding, market, options),
    }))
    .sort(
      (left, right) =>
        right.evaluation.scores.total -
          left.evaluation.scores.total ||
        left.index - right.index,
    );

  // Higher-scoring findings are recorded first so a repeated
  // claim keeps its strongest source and later copies are duplicates.
  const seen: KnownClaim[] = [...(options.knownClaims ?? [])];
  const ranked: EvidenceEvaluation[] = [];

  for (const item of preliminary) {
    const evaluation = isDuplicate(item.finding, seen)
      ? evaluateFinding(item.finding, market, {
          ...options,
          knownClaims: seen,
        })
      : item.evaluation;

    ranked.push(evaluation);
    seen.push({
      claim: item.finding.claim,
      marketAddress: item.finding.marketAddress,
      sourceUrl: item.finding.sourceUrl,
    });
  }

  return ranked.sort(
    (left, right) => right.scores.total - left.scores.total,
  );
}

/**
 * Builds the options `rankFindings` requires.
 *
 * Market relevance is only a fallback. A finding's own
 * `relevanceAssessment.score` still takes precedence inside
 * `evaluateFinding`.
 */
export function buildEvidenceResearchOptions(params: {
  marketAddress: string;
  findings: readonly ResearchFinding[];
  credibility: Record<EvidenceSourceType, number>;
  getVerifiability: (sourceUrl: string) => number;
  now?: number;
  knownClaims?: KnownClaim[];
  marketRelevance?: number;
  weights?: EvidenceResearchOptions["weights"];
}): EvidenceResearchOptions {
  if (
    typeof params.marketAddress !== "string" ||
    !params.marketAddress.trim()
  ) {
    throw new Error("Market address is required");
  }

  const verifiability: Record<string, number> = {};

  for (const finding of params.findings) {
    verifiability[finding.sourceUrl] = params.getVerifiability(
      finding.sourceUrl,
    );
  }

  return {
    now: params.now,
    knownClaims: params.knownClaims ?? [],
    relevance: {
      [params.marketAddress]: params.marketRelevance ?? 0,
    },
    credibility: params.credibility,
    verifiability,
    weights: params.weights,
  };
}
