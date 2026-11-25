
import type {
  EvidenceAssessmentInput,
  EvidenceAssessmentModel,
  EvidenceRelationship,
} from "./evidence-assessor.js";

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "among",
  "because",
  "before",
  "being",
  "between",
  "could",
  "does",
  "during",
  "each",
  "from",
  "have",
  "into",
  "more",
  "most",
  "must",
  "only",
  "other",
  "over",
  "same",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "until",
  "very",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "your",
  "market",
  "markets",
  "question",
]);

const JURISDICTIONS = [
  {
    id: "nigeria",
    aliases: [
      "Nigeria",
      "Nigerian",
      "Central Bank of Nigeria",
    ],
  },
  {
    id: "ghana",
    aliases: ["Ghana", "Ghanaian"],
  },
  {
    id: "kenya",
    aliases: ["Kenya", "Kenyan"],
  },
  {
    id: "south-africa",
    aliases: ["South Africa", "South African"],
  },
  {
    id: "united-states",
    aliases: [
      "United States",
      "U.S.",
      "U.S. economy",
      "American",
      "Federal Reserve",
    ],
  },
  {
    id: "united-kingdom",
    aliases: [
      "United Kingdom",
      "Britain",
      "British",
      "UK",
      "Bank of England",
    ],
  },
  {
    id: "china",
    aliases: ["China", "Chinese"],
  },
  {
    id: "india",
    aliases: ["India", "Indian"],
  },
  {
    id: "japan",
    aliases: ["Japan", "Japanese"],
  },
  {
    id: "canada",
    aliases: ["Canada", "Canadian"],
  },
  {
    id: "australia",
    aliases: ["Australia", "Australian"],
  },
  {
    id: "brazil",
    aliases: ["Brazil", "Brazilian"],
  },
  {
    id: "russia",
    aliases: ["Russia", "Russian"],
  },
  {
    id: "germany",
    aliases: ["Germany", "German"],
  },
  {
    id: "france",
    aliases: ["France", "French"],
  },
  {
    id: "italy",
    aliases: ["Italy", "Italian"],
  },
  {
    id: "spain",
    aliases: ["Spain", "Spanish"],
  },
  {
    id: "mexico",
    aliases: ["Mexico", "Mexican"],
  },
  {
    id: "egypt",
    aliases: ["Egypt", "Egyptian"],
  },
  {
    id: "ethiopia",
    aliases: ["Ethiopia", "Ethiopian"],
  },
  {
    id: "uganda",
    aliases: ["Uganda", "Ugandan"],
  },
  {
    id: "tanzania",
    aliases: ["Tanzania", "Tanzanian"],
  },
  {
    id: "senegal",
    aliases: ["Senegal", "Senegalese"],
  },
  {
    id: "ivory-coast",
    aliases: ["Ivory Coast", "Cote d'Ivoire"],
  },
  {
    id: "united-arab-emirates",
    aliases: ["United Arab Emirates", "UAE"],
  },
  {
    id: "saudi-arabia",
    aliases: ["Saudi Arabia", "Saudi"],
  },
  {
    id: "turkey",
    aliases: ["Turkey", "Turkish"],
  },
  {
    id: "indonesia",
    aliases: ["Indonesia", "Indonesian"],
  },
  {
    id: "pakistan",
    aliases: ["Pakistan", "Pakistani"],
  },
  {
    id: "bangladesh",
    aliases: ["Bangladesh", "Bangladeshi"],
  },
  {
    id: "philippines",
    aliases: ["Philippines", "Filipino"],
  },
  {
    id: "new-zealand",
    aliases: ["New Zealand", "New Zealander"],
  },
  {
    id: "switzerland",
    aliases: ["Switzerland", "Swiss"],
  },
  {
    id: "netherlands",
    aliases: ["Netherlands", "Dutch"],
  },
  {
    id: "ireland",
    aliases: ["Ireland", "Irish"],
  },
  {
    id: "israel",
    aliases: ["Israel", "Israeli"],
  },
  {
    id: "ukraine",
    aliases: ["Ukraine", "Ukrainian"],
  },
  {
    id: "argentina",
    aliases: ["Argentina", "Argentinian"],
  },
] as const;

const JURISDICTION_MISMATCH_MULTIPLIER = 0.5;

const DIRECT_SUPPORT =
  /\b(confirmed|officially announced|officially published|has fallen|fell to|fell below|announced that|approved|enacted|signed into law)\b/i;

const CONTRADICTION =
  /\b(did not|does not|do not|will not|has not|have not|failed to|no longer|denied|rejected|remains above|stayed above|ruled out|cancelled|canceled|withdrawn|contrary to)\b/i;

const HEDGE =
  /\b(could|might|expected to|outlook|possible|potential|likely|forecast|projected|analysts)\b/i;

const CONTEXT =
  /\b(outlook|background|historically|context|compared against|provide information|forecast|projected|analysts|expected to)\b/i;

const MIN_STATEMENT_LENGTH = 35;
const MAX_STATEMENT_LENGTH = 600;
const MIN_STATEMENT_MATCHES = 2;
const MIN_STATEMENT_RELEVANCE = 0.10;

const BOILERPLATE_PATTERNS = [
  /^read more\b/i,
  /^click here\b/i,
  /^subscribe\b/i,
  /^sign up\b/i,
  /^follow us\b/i,
  /^share this\b/i,
  /^send a tip\b/i,
  /^advertisement\b/i,
  /^related (articles|stories|news)\b/i,
  /^photograph(?:er)?\s*(by|:)/i,
  /^photo\s*(by|:)/i,
  /^image source\b/i,
  /^copyright\b/i,
  /^all rights reserved\b/i,
  /^terms (of|and)\b/i,
];

function tokenize(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
      (word) => !STOP_WORDS.has(word),
    ),
  );
}

function buildTargetWeights(
  question: string,
  criteria: string,
): Map<string, number> {
  const weights = new Map<string, number>();

  for (const word of tokenize(question)) {
    weights.set(word, (weights.get(word) ?? 0) + 1);
  }

  for (const word of tokenize(criteria)) {
    weights.set(word, (weights.get(word) ?? 0) + 2);
  }

  return weights;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsAlias(text: string, alias: string): boolean {
  const pattern = new RegExp(
    `(^|[^a-z])${escapeRegExp(alias)}([^a-z]|$)`,
    "i",
  );

  return pattern.test(text);
}

function findJurisdictions(text: string): Set<string> {
  const found = new Set<string>();

  for (const jurisdiction of JURISDICTIONS) {
    const matched = jurisdiction.aliases.some((alias) =>
      containsAlias(text, alias),
    );

    if (matched) {
      found.add(jurisdiction.id);
    }
  }

  return found;
}

function hasJurisdictionMismatch(
  marketText: string,
  evidenceText: string,
): boolean {
  const marketJurisdictions = findJurisdictions(marketText);

  if (marketJurisdictions.size === 0) {
    return false;
  }

  const evidenceJurisdictions = findJurisdictions(evidenceText);

  if (evidenceJurisdictions.size === 0) {
    return false;
  }

  const directlyRelevant = [...evidenceJurisdictions].some(
    (jurisdiction) => marketJurisdictions.has(jurisdiction),
  );

  return !directlyRelevant;
}

/**
 * Splits text into sentences while preserving decimal numbers
 * such as 18.5%, 3.14 and 2.75.
 */
function splitSentences(text: string): string[] {
  return (
    text.match(/[\s\S]*?(?:[.!?]+(?=\s|$)|$)/g) ?? []
  )
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function hasHedge(text: string): boolean {
  if (HEDGE.test(text)) {
    return true;
  }

  // Lowercase only, so the month "May" is not treated as a hedge.
  return /\bmay\b/.test(text);
}

/**
 * Classifies the role of evidence without deciding the market outcome.
 *
 * Keyword overlap alone stays inconclusive. Explicit outcome language
 * is required before a result can be direct support or a contradiction.
 * A jurisdiction mismatch downgrades those labels to context.
 */
export function classifyEvidenceRelationship(params: {
  relevanceScore: number;
  matchedTermCount: number;
  evidenceText: string;
  jurisdictionMismatch: boolean;
}): EvidenceRelationship {
  if (
    params.relevanceScore === 0 ||
    params.matchedTermCount === 0
  ) {
    return "irrelevant";
  }

  if (params.matchedTermCount < 2) {
    return "inconclusive";
  }

  const support = DIRECT_SUPPORT.test(params.evidenceText);
  const contradiction = CONTRADICTION.test(params.evidenceText);
  const hedged = hasHedge(params.evidenceText);
  const contextual = CONTEXT.test(params.evidenceText);

  let relationship: EvidenceRelationship;

  if (support && contradiction) {
    relationship = "inconclusive";
  } else if (contradiction && !hedged) {
    relationship = "contradiction";
  } else if (support && !hedged) {
    relationship = "direct_support";
  } else if (
    hedged ||
    contextual ||
    params.jurisdictionMismatch
  ) {
    relationship = "context";
  } else {
    relationship = "inconclusive";
  }

  if (
    params.jurisdictionMismatch &&
    (relationship === "direct_support" ||
      relationship === "contradiction")
  ) {
    return "context";
  }

  return relationship;
}

function isBoilerplateStatement(statement: string): boolean {
  return BOILERPLATE_PATTERNS.some((pattern) =>
    pattern.test(statement.trim()),
  );
}

export interface SupportingStatementAssessment {
  relevanceScore: number;
  matchedTerms: string[];
  rationale: string;
  isRelevant: boolean;
}

/**
 * Independently assesses one statement against the market question
 * and resolution criteria.
 *
 * This is a deterministic screening score, not factual verification.
 */
export function assessSupportingStatement(
  marketQuestion: string,
  resolutionCriteria: string,
  statement: string,
): SupportingStatementAssessment {
  const claim = statement.trim();

  if (
    claim.length < MIN_STATEMENT_LENGTH ||
    claim.length > MAX_STATEMENT_LENGTH ||
    isBoilerplateStatement(claim)
  ) {
    return {
      relevanceScore: 0,
      matchedTerms: [],
      rationale:
        "The statement was excluded by the statement-quality filter.",
      isRelevant: false,
    };
  }

  const targetWeights = buildTargetWeights(
    marketQuestion,
    resolutionCriteria,
  );

  if (targetWeights.size === 0) {
    return {
      relevanceScore: 0,
      matchedTerms: [],
      rationale: "The market has no usable target terms.",
      isRelevant: false,
    };
  }

  const statementTerms = tokenize(claim);

  let totalWeight = 0;
  let matchedWeight = 0;

  const matchedTerms: string[] = [];

  for (const [term, weight] of targetWeights) {
    totalWeight += weight;

    if (statementTerms.has(term)) {
      matchedWeight += weight;
      matchedTerms.push(term);
    }
  }

  const keywordScore =
    totalWeight === 0 ? 0 : matchedWeight / totalWeight;

  const jurisdictionMismatch = hasJurisdictionMismatch(
    `${marketQuestion} ${resolutionCriteria}`,
    claim,
  );

  const relevanceScore = jurisdictionMismatch
    ? keywordScore * JURISDICTION_MISMATCH_MULTIPLIER
    : keywordScore;

  const isRelevant =
    matchedTerms.length >= MIN_STATEMENT_MATCHES &&
    relevanceScore >= MIN_STATEMENT_RELEVANCE;

  const rationale = isRelevant
    ? `The statement independently matched ${matchedTerms.length} distinct market term(s): ${matchedTerms.join(", ")}.`
    : `The statement did not meet the minimum statement-level relevance requirements. Matched ${matchedTerms.length} distinct term(s): ${matchedTerms.join(", ") || "none"}.`;

  return {
    relevanceScore,
    matchedTerms,
    rationale,
    isRelevant,
  };
}

/**
 * Extracts statements that independently pass the relevance screen.
 *
 * The article's matched keywords are not reused as a substitute
 * for assessing each sentence.
 */
function extractSupportingStatements(
  excerpt: string,
  marketQuestion: string,
  resolutionCriteria: string,
): string[] {
  const seen = new Set<string>();

  return splitSentences(excerpt)
    .map((sentence, index) => ({
      sentence,
      index,
      assessment: assessSupportingStatement(
        marketQuestion,
        resolutionCriteria,
        sentence,
      ),
    }))
    .filter(({ sentence, assessment }) => {
      const normalised = sentence
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

      if (!assessment.isRelevant || seen.has(normalised)) {
        return false;
      }

      seen.add(normalised);
      return true;
    })
    .sort(
      (a, b) =>
        b.assessment.relevanceScore - a.assessment.relevanceScore ||
        a.index - b.index,
    )
    .slice(0, 3)
    .map(({ sentence }) => sentence);
}

/**
 * Deterministic rule-based evidence assessor.
 *
 * This component:
 * - Measures keyword overlap with the market question.
 * - Gives additional weight to resolution criteria.
 * - Applies a penalty to explicitly mismatched jurisdictions.
 * - Assesses each supporting statement independently.
 * - Does not infer YES or NO from keyword overlap.
 * - Labels direct support, contradiction, context, irrelevant
 *   and inconclusive evidence separately from that direction.
 * - Reports its verification limitations.
 *
 * It is a screening component, not a replacement for
 * semantic analysis or human evidence verification.
 */
export const ruleBasedEvidenceAssessor: EvidenceAssessmentModel =
  async (input: EvidenceAssessmentInput) => {
    const targetWeights = buildTargetWeights(
      input.marketQuestion,
      input.resolutionCriteria,
    );

    const evidenceText = `${input.evidenceClaim} ${input.sourceExcerpt}`;

    const evidenceTerms = tokenize(evidenceText);

    let totalWeight = 0;
    let matchedWeight = 0;

    const matchedTerms: string[] = [];

    for (const [term, weight] of targetWeights) {
      totalWeight += weight;

      if (evidenceTerms.has(term)) {
        matchedWeight += weight;
        matchedTerms.push(term);
      }
    }

    const keywordRelevanceScore =
      totalWeight === 0 ? 0 : matchedWeight / totalWeight;

    const jurisdictionMismatch = hasJurisdictionMismatch(
      `${input.marketQuestion} ${input.resolutionCriteria}`,
      evidenceText,
    );

    const relevanceScore = jurisdictionMismatch
      ? keywordRelevanceScore * JURISDICTION_MISMATCH_MULTIPLIER
      : keywordRelevanceScore;

    const supportingStatements = extractSupportingStatements(
      input.sourceExcerpt,
      input.marketQuestion,
      input.resolutionCriteria,
    );

    const keywordRationale =
      matchedTerms.length > 0
        ? `The article contains ${matchedTerms.length} distinct term(s) relevant to the market question or resolution criteria: ${matchedTerms.join(", ")}.`
        : "No meaningful keyword overlap was found between the article and the market question or resolution criteria.";

    const jurisdictionRationale = jurisdictionMismatch
      ? " A jurisdiction mismatch was detected: the market identifies a specific country, but the evidence explicitly identifies a different country without mentioning the market jurisdiction. The relevance score was reduced by 50%."
      : "";

    const relationship = classifyEvidenceRelationship({
      relevanceScore: keywordRelevanceScore,
      matchedTermCount: matchedTerms.length,
      evidenceText:
        supportingStatements.length > 0
          ? `${input.evidenceClaim} ${supportingStatements.join(" ")}`
          : evidenceText,
      jurisdictionMismatch,
    });

    // Direction is deliberately omitted: keyword overlap cannot
    // establish whether the evidence supports YES or NO.
    return {
      relationship,
      relevanceScore,
      rationale: `${keywordRationale}${jurisdictionRationale} Evidence relationship: ${relationship}.`,
      supportingStatements,
      limitations: [
        "This is a deterministic keyword-overlap screen, not semantic verification.",
        "Matching words do not establish that the article's claims are true.",
        "Publisher credibility and source independence have not been verified.",
        "Jurisdiction detection uses a limited list of explicit country names, demonyms and institutional references; it may miss indirect or ambiguous references.",
        "A jurisdiction mismatch is a heuristic relevance penalty, not proof that foreign evidence is irrelevant.",
        "Statement-level relevance is also a keyword heuristic and may retain sentences that are contextually misleading.",
        "The evidence direction is omitted because keyword overlap alone cannot establish YES or NO support.",
        "The evidence relationship is a separate heuristic label and does not by itself prove the market outcome.",
        "A human must verify the original source, publication date, context and market resolution criteria.",
      ],
    };
  };

