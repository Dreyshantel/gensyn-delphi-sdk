
import type {
  EvidenceSourceType,
} from "./evidence-research.js";

/**
 * Initial credibility assumptions.
 *
 * These are configurable starting values, not verified
 * measurements of every publisher in each category.
 */
export const DEFAULT_SOURCE_CREDIBILITY: Record<
  EvidenceSourceType,
  number
> = {
  official: 0.90,
  regulatory: 0.95,
  academic: 0.85,
  news: 0.65,
  other: 0.35,
};

export const DEFAULT_VERIFIABILITY_SCORE = 0.35;

export interface EvidenceScoringPolicyOptions {
  /**
   * Explicit domain-to-category mappings.
   *
   * Unknown domains are classified as "other".
   * Matching is exact after removing a leading "www.".
   */
  sourceTypesByDomain?: Record<string, EvidenceSourceType>;

  /**
   * Optional credibility overrides by source category.
   */
  credibility?: Partial<
    Record<EvidenceSourceType, number>
  >;

  /**
   * Explicit verifiability overrides by complete source URL.
   */
  verifiabilityByUrl?: Record<string, number>;

  /**
   * Conservative fallback for URLs without an explicit
   * verifiability assessment.
   */
  defaultVerifiability?: number;
}

export interface EvidenceScoringPolicy {
  classifySource(sourceUrl: string): EvidenceSourceType;
  getCredibility(sourceType: EvidenceSourceType): number;
  getVerifiability(sourceUrl: string): number;
  credibility: Record<EvidenceSourceType, number>;
}

function validateScore(
  name: string,
  value: number,
): void {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(
      `${name} must be between 0 and 1`,
    );
  }
}

function normaliseDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
}

function normaliseUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl);

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new Error(
      "Source URL must use HTTP or HTTPS",
    );
  }

  url.hash = "";

  return url.toString();
}

export function createEvidenceScoringPolicy(
  options: EvidenceScoringPolicyOptions = {},
): EvidenceScoringPolicy {
  const credibility = {
    ...DEFAULT_SOURCE_CREDIBILITY,
    ...options.credibility,
  };

  for (const [sourceType, score] of Object.entries(
    credibility,
  )) {
    validateScore(
      `Credibility for ${sourceType}`,
      score,
    );
  }

  const defaultVerifiability =
    options.defaultVerifiability ??
    DEFAULT_VERIFIABILITY_SCORE;

  validateScore(
    "Default verifiability",
    defaultVerifiability,
  );

  const sourceTypesByDomain = new Map<
    string,
    EvidenceSourceType
  >();

  for (const [domain, sourceType] of Object.entries(
    options.sourceTypesByDomain ?? {},
  )) {
    if (!domain.trim()) {
      throw new Error(
        "Source classification domain cannot be empty",
      );
    }

    sourceTypesByDomain.set(
      normaliseDomain(domain),
      sourceType,
    );
  }

  const verifiabilityByUrl = new Map<string, number>();

  for (const [sourceUrl, score] of Object.entries(
    options.verifiabilityByUrl ?? {},
  )) {
    validateScore(
      `Verifiability for ${sourceUrl}`,
      score,
    );

    verifiabilityByUrl.set(
      normaliseUrl(sourceUrl),
      score,
    );
  }

  return {
    classifySource(sourceUrl) {
      const url = new URL(normaliseUrl(sourceUrl));
      const domain = normaliseDomain(url.hostname);

      return sourceTypesByDomain.get(domain) ?? "other";
    },

    getCredibility(sourceType) {
      return credibility[sourceType];
    },

    getVerifiability(sourceUrl) {
      const normalisedUrl = normaliseUrl(sourceUrl);

      return (
        verifiabilityByUrl.get(normalisedUrl) ??
        defaultVerifiability
      );
    },

    credibility,
  };
}

