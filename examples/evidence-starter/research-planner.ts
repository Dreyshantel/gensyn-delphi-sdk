
import type { EvidenceSourceType } from "./evidence-research.js";

export interface ResearchPlanningInput {
  marketAddress: string;
  marketQuestion: string;
  resolutionCriteria: string;
  evidenceCutoffAt: string;
  suggestedDataSources: string[];
}

export interface ResearchQuery {
  query: string;
  objective: string;
  sourceTypes: EvidenceSourceType[];
}

export interface ResearchPlan {
  marketAddress: string;
  queries: ResearchQuery[];
}

export type ResearchQueryGenerator = (
  input: ResearchPlanningInput,
) => Promise<unknown>;

const VALID_SOURCE_TYPES: EvidenceSourceType[] = [
  "official",
  "regulatory",
  "academic",
  "news",
  "other",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function validateInput(
  input: ResearchPlanningInput,
  now: number,
): void {
  const requiredFields = [
    "marketAddress",
    "marketQuestion",
    "resolutionCriteria",
  ] as const;

  for (const field of requiredFields) {
    if (
      typeof input[field] !== "string" ||
      input[field].trim() === ""
    ) {
      throw new Error(`${field} cannot be empty`);
    }
  }

  if (
    !Number.isFinite(Date.parse(input.evidenceCutoffAt))
  ) {
    throw new Error("Invalid evidence cutoff date");
  }

  if (Date.parse(input.evidenceCutoffAt) <= now) {
    throw new Error("Market evidence cutoff has passed");
  }

  if (
    !Array.isArray(input.suggestedDataSources) ||
    !input.suggestedDataSources.every(
      (source) =>
        typeof source === "string" && source.trim() !== "",
    )
  ) {
    throw new Error("Suggested data sources must be non-empty strings");
  }
}

function normaliseQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function validateResearchPlan(
  value: unknown,
  marketAddress: string,
): ResearchPlan {
  if (!isRecord(value) || !Array.isArray(value.queries)) {
    throw new Error("Research plan must contain a queries array");
  }

  if (value.queries.length < 3 || value.queries.length > 8) {
    throw new Error("Research plan must contain between 3 and 8 queries");
  }

  const seenQueries = new Set<string>();

  const queries = value.queries.map(
    (item: unknown, index: number): ResearchQuery => {
      if (!isRecord(item)) {
        throw new Error(`Research query ${index} must be an object`);
      }

      const { query, objective, sourceTypes } = item;

      if (typeof query !== "string" || !query.trim()) {
        throw new Error(`Research query ${index} has an empty query`);
      }

      if (typeof objective !== "string" || !objective.trim()) {
        throw new Error(`Research query ${index} has an empty objective`);
      }

      if (
        !Array.isArray(sourceTypes) ||
        sourceTypes.length === 0 ||
        !sourceTypes.every(
          (type) =>
            typeof type === "string" &&
            VALID_SOURCE_TYPES.includes(type as EvidenceSourceType),
        )
      ) {
        throw new Error(
          `Research query ${index} has invalid source types`,
        );
      }

      const normalised = normaliseQuery(query);

      if (seenQueries.has(normalised)) {
        throw new Error("Research plan contains duplicate queries");
      }

      seenQueries.add(normalised);

      return {
        query: query.trim(),
        objective: objective.trim(),
        sourceTypes: [...new Set(sourceTypes)] as EvidenceSourceType[],
      };
    },
  );

  return {
    marketAddress,
    queries,
  };
}

/**
 * Generates targeted research queries for a Delphi market.
 *
 * The generator is injected so the planner is independent
 * of any particular AI provider.
 */
export async function planResearchQueries(
  input: ResearchPlanningInput,
  generator: ResearchQueryGenerator,
  now = Date.now(),
): Promise<ResearchPlan> {
  validateInput(input, now);

  const response = await generator(input);

  return validateResearchPlan(response, input.marketAddress);
}

