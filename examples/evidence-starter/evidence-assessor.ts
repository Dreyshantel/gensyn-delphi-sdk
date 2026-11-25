
export type EvidenceDirection = "yes" | "no";

/**
 * How a source relates to the market outcome.
 *
 * This is separate from `direction`. Direction names the YES/NO
 * outcome a reviewer is prepared to assert. Relationship names
 * the role of the text even when that outcome is not asserted.
 */
export type EvidenceRelationship =
  | "direct_support"
  | "contradiction"
  | "context"
  | "irrelevant"
  | "inconclusive";

export interface EvidenceAssessmentInput {
  marketQuestion: string;
  resolutionCriteria: string;
  evidenceClaim: string;
  sourceExcerpt: string;
  sourceUrl: string;
  /**
   * When the source was published.
   * This is not a substitute for the event date.
   */
  publishedAt?: string;
  /**
   * When the reported event occurred.
   * Omit this when the event date cannot be extracted.
   */
  evidenceDate?: string;
  evidenceCutoffAt: string;
}

export interface EvidenceAssessment {
  direction?: EvidenceDirection;
  relationship: EvidenceRelationship;
  relevanceScore: number;
  rationale: string;
  supportingStatements: string[];
  limitations: string[];
}

export type EvidenceAssessmentModel = (
  input: EvidenceAssessmentInput,
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

const VALID_RELATIONSHIPS: EvidenceRelationship[] = [
  "direct_support",
  "contradiction",
  "context",
  "irrelevant",
  "inconclusive",
];

function assertDate(name: string, value: string): number {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${name}`);
  }

  return timestamp;
}

function relationshipForDirection(
  direction: EvidenceDirection,
): EvidenceRelationship {
  switch (direction) {
    case "yes":
      return "direct_support";
    case "no":
      return "contradiction";
  }
}

function validateInput(input: EvidenceAssessmentInput): void {
  const requiredFields = [
    "marketQuestion",
    "resolutionCriteria",
    "evidenceClaim",
    "sourceExcerpt",
    "sourceUrl",
  ] as const;

  for (const field of requiredFields) {
    if (
      typeof input[field] !== "string" ||
      input[field].trim() === ""
    ) {
      throw new Error(`${field} cannot be empty`);
    }
  }

  try {
    const url = new URL(input.sourceUrl);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error();
    }
  } catch {
    throw new Error("Source URL must be a valid HTTP or HTTPS URL");
  }

  const publishedAt = input.publishedAt?.trim()
    ? input.publishedAt
    : undefined;
  const evidenceDate = input.evidenceDate?.trim()
    ? input.evidenceDate
    : undefined;

  if (!publishedAt && !evidenceDate) {
    throw new Error(
      "A publication date or an evidence date is required",
    );
  }

  const publishedTime = publishedAt
    ? assertDate("publishedAt", publishedAt)
    : undefined;
  const evidenceTime = evidenceDate
    ? assertDate("evidenceDate", evidenceDate)
    : undefined;
  const cutoff = assertDate(
    "evidenceCutoffAt",
    input.evidenceCutoffAt,
  );

  if (publishedTime !== undefined && publishedTime > cutoff) {
    throw new Error(
      "Publication date is after the market evidence cutoff",
    );
  }

  if (evidenceTime !== undefined && evidenceTime > cutoff) {
    throw new Error(
      "Evidence date is after the market evidence cutoff",
    );
  }

  if (
    publishedTime !== undefined &&
    evidenceTime !== undefined &&
    evidenceTime > publishedTime
  ) {
    throw new Error(
      "Evidence date cannot be after the publication date",
    );
  }
}

function validateAssessment(value: unknown): EvidenceAssessment {
  if (!isRecord(value)) {
    throw new Error("Assessment response must be an object");
  }

  const {
    direction,
    relationship,
    relevanceScore,
    rationale,
    supportingStatements,
    limitations,
  } = value;

  if (
    direction !== undefined &&
    direction !== "yes" &&
    direction !== "no"
  ) {
    throw new Error("Assessment has an invalid evidence direction");
  }

  if (
    relationship !== undefined &&
    !VALID_RELATIONSHIPS.includes(
      relationship as EvidenceRelationship,
    )
  ) {
    throw new Error("Assessment has an invalid evidence relationship");
  }

  if (
    typeof relevanceScore !== "number" ||
    !Number.isFinite(relevanceScore) ||
    relevanceScore < 0 ||
    relevanceScore > 1
  ) {
    throw new Error("Relevance score must be between 0 and 1");
  }

  if (typeof rationale !== "string" || !rationale.trim()) {
    throw new Error("Assessment rationale cannot be empty");
  }

  if (
    !Array.isArray(supportingStatements) ||
    !supportingStatements.every(
      (statement) =>
        typeof statement === "string" && statement.trim() !== "",
    )
  ) {
    throw new Error("Supporting statements must be non-empty strings");
  }

  if (
    !Array.isArray(limitations) ||
    !limitations.every(
      (limitation) =>
        typeof limitation === "string" && limitation.trim() !== "",
    )
  ) {
    throw new Error("Limitations must be non-empty strings");
  }

  if (direction === undefined && relationship === undefined) {
    throw new Error(
      "Assessment must include a direction or evidence relationship",
    );
  }

  const resolvedRelationship =
    relationship === undefined
      ? relationshipForDirection(direction as EvidenceDirection)
      : (relationship as EvidenceRelationship);

  return {
    ...(direction === undefined ? {} : { direction }),
    relationship: resolvedRelationship,
    relevanceScore,
    rationale: rationale.trim(),
    supportingStatements: supportingStatements.map((item) => item.trim()),
    limitations: limitations.map((item) => item.trim()),
  };
}

/**
 * Assesses evidence using an injected model implementation.
 *
 * This function validates the input and model response.
 * It does not itself perform AI inference.
 */
export async function assessEvidence(
  input: EvidenceAssessmentInput,
  model: EvidenceAssessmentModel,
): Promise<EvidenceAssessment> {
  validateInput(input);

  const response = await model(input);

  return validateAssessment(response);
}

