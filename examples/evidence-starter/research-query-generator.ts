
import type {
  ResearchPlanningInput,
  ResearchQuery,
  ResearchQueryGenerator,
} from "./research-planner.js";

/**
 * Countries and common geographic descriptions used to identify
 * the jurisdiction of a market.
 *
 * This is deliberately a lightweight lookup, not a full named-entity
 * recognition system.
 */
const GEOGRAPHIC_ALIASES: Record<string, string[]> = {
  Nigeria: ["nigeria", "nigerian"],
  Ghana: ["ghana", "ghanaian"],
  Kenya: ["kenya", "kenyan"],
  "South Africa": ["south africa", "south african"],
  Uganda: ["uganda", "ugandan"],
  Tanzania: ["tanzania", "tanzanian"],
  Rwanda: ["rwanda", "rwandan"],
  Senegal: ["senegal", "senegalese"],
  "United Kingdom": ["united kingdom", "britain", "british", "uk"],
  "United States": [
    "united states",
    "united states of america",
    "american",
    "usa",
  ],
  Canada: ["canada", "canadian"],
  India: ["india", "indian"],
  Australia: ["australia", "australian"],
  Germany: ["germany", "german"],
  France: ["france", "french"],
  China: ["china", "chinese"],
  Japan: ["japan", "japanese"],
  Brazil: ["brazil", "brazilian"],
  Mexico: ["mexico", "mexican"],
  Argentina: ["argentina", "argentinian"],
  Indonesia: ["indonesia", "indonesian"],
  Pakistan: ["pakistan", "pakistani"],
  Bangladesh: ["bangladesh", "bangladeshi"],
  Egypt: ["egypt", "egyptian"],
  Ethiopia: ["ethiopia", "ethiopian"],
  "Saudi Arabia": ["saudi arabia", "saudi"],
  "United Arab Emirates": ["united arab emirates", "uae"],
  Russia: ["russia", "russian"],
  Ukraine: ["ukraine", "ukrainian"],
  Turkey: ["turkey", "turkish"],
  Israel: ["israel", "israeli"],
};

/**
 * Normalise text for query construction and duplicate detection.
 */
function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Remove punctuation and normalise casing for comparison.
 */
function normaliseQuery(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

/**
 * Detect a likely country or jurisdiction from the market question
 * and resolution criteria.
 *
 * Returns the canonical country name so searches use consistent
 * geographic wording.
 */
function detectGeographicContext(
  question: string,
  criteria: string,
): string | undefined {
  const text = ` ${normaliseQuery(`${question} ${criteria}`)} `;

  for (const [country, aliases] of Object.entries(GEOGRAPHIC_ALIASES)) {
    const found = aliases.some((alias) => {
      const normalisedAlias = normaliseQuery(alias);
      return text.includes(` ${normalisedAlias} `);
    });

    if (found) {
      return country;
    }
  }

  return undefined;
}

/**
 * Infer a likely source category from a suggested source name.
 *
 * This is a heuristic, not a claim that the source is credible.
 */
function inferSourceType(
  source: string,
): ResearchQuery["sourceTypes"] {
  const value = source.toLowerCase();

  if (
    /ministry|government|presidency|parliament|court|agency|official|bureau|statistics office/.test(
      value,
    )
  ) {
    return ["official"];
  }

  if (
    /regulator|commission|central bank|cbn|sec|authority/.test(value)
  ) {
    return ["regulatory"];
  }

  if (
    /university|journal|research|academic|institute/.test(value)
  ) {
    return ["academic"];
  }

  if (
    /news|reuters|bbc|associated press|ap news|newspaper|publisher|press/.test(
      value,
    )
  ) {
    return ["news"];
  }

  return ["other"];
}

/**
 * Add explicit geographic context to a query when a country
 * or jurisdiction can be identified.
 */
function withGeographicContext(
  query: string,
  country: string | undefined,
): string {
  if (!country) {
    return query;
  }

  return `${query} "${country}"`;
}

/**
 * Generate deterministic research queries without an external AI service.
 *
 * The returned queries are search instructions only.
 * They are not evidence and must not be submitted as factual claims.
 */
export const ruleBasedResearchQueryGenerator: ResearchQueryGenerator =
  async (input: ResearchPlanningInput): Promise<unknown> => {
    const question = cleanText(input.marketQuestion);
    const criteria = cleanText(input.resolutionCriteria);

    const country = detectGeographicContext(question, criteria);

    const queries: ResearchQuery[] = [
      {
        query: withGeographicContext(
          `${question} official announcements published statements primary-source documents`,
          country,
        ),
        objective:
          "Find primary-source announcements, published statements, and official documents directly relevant to the market question and its jurisdiction.",
        sourceTypes: ["official"],
      },
      {
        query: withGeographicContext(
          `${criteria} official government regulatory documents`,
          country,
        ),
        objective:
          "Find official documents, regulations, or government publications that establish how the market will be resolved.",
        sourceTypes: ["official", "regulatory"],
      },
      {
        query: withGeographicContext(
          `${question} independent credible news reporting`,
          country,
        ),
        objective:
          "Find independent reporting from relevant publishers that corroborates or challenges the available primary-source evidence.",
        sourceTypes: ["news"],
      },
      {
        query: withGeographicContext(
          `${question} research reports datasets historical records`,
          country,
        ),
        objective:
          "Find research, datasets, and historical records relevant to the market and its geographic context.",
        sourceTypes: ["academic", "other"],
      },
    ];

    // Add up to three focused queries based on suggested sources.
    for (const source of input.suggestedDataSources.slice(0, 3)) {
      const sourceName = cleanText(source);

      if (!sourceName) {
        continue;
      }

      const sourceQuery = country
        ? `${question} "${sourceName}" "${country}"`
        : `${question} "${sourceName}"`;

      queries.push({
        query: sourceQuery,
        objective:
          `Search ${sourceName} for information directly relevant to the market. Prioritise original publications, dated reports, official statements, and independently verifiable material.`,
        sourceTypes: inferSourceType(sourceName),
      });
    }

    // Remove duplicate queries while preserving their original order.
    const uniqueQueries = new Map<string, ResearchQuery>();

    for (const item of queries) {
      const key = normaliseQuery(item.query);

      if (!uniqueQueries.has(key)) {
        uniqueQueries.set(key, item);
      }
    }

    return {
      queries: [...uniqueQueries.values()].slice(0, 8),
    };
  };

