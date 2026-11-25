/**
 * Search queries that news search engines can actually answer.
 *
 * The original generator pasted the whole market question into every
 * query ("Will X happen by 31 December 2026? official government
 * regulatory documents"). Search engines match keywords, so long
 * sentence-style queries return few, stale or loosely related results.
 *
 * This generator:
 *   - reduces the question to its key terms (names, numbers, topic words),
 *   - adds Google News' `when:7d` operator to the freshness queries,
 *     because judgment rewards pay for facts the forecaster does not
 *     know yet, and those are mostly recent,
 *   - targets the market's own data sources,
 *   - optionally asks an LLM for a few specific queries (one call per
 *     market), falling back to the rule-based queries on any problem.
 */

import type {
  ResearchPlanningInput,
  ResearchQuery,
  ResearchQueryGenerator,
} from "./research-planner.js";
import type { EvidenceSourceType } from "./evidence-research.js";
import type { LlmClient } from "./llm-client.js";

const QUESTION_STOP_WORDS = new Set([
  "will", "would", "does", "do", "did", "is", "are", "was", "were", "be",
  "been", "has", "have", "had", "can", "could", "should", "the", "a", "an",
  "of", "to", "in", "on", "at", "by", "for", "from", "with", "and", "or",
  "than", "that", "this", "these", "those", "its", "their", "his", "her",
  "any", "all", "more", "less", "least", "most", "before", "after",
  "during", "between", "end", "least", "who", "what", "which", "when",
  "where", "how", "whether", "yes", "no", "market", "resolve", "resolves",
  "according", "officially", "reported", "announced", "become", "get",
  "make", "reach", "above", "below", "over", "under", "into", "out",
]);

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";

/** Removes deadline phrases such as "by 31 December 2026" or "before Q1 2027". */
function stripDeadline(question: string): string {
  return question
    .replace(
      new RegExp(
        `\\b(by|before|on|until|in|at|as of|prior to)\\s+(the\\s+)?(end\\s+of\\s+)?` +
          `((\\d{1,2}(st|nd|rd|th)?\\s+)?(${MONTHS})(\\s+\\d{1,2}(st|nd|rd|th)?)?,?(\\s+\\d{4})?|q[1-4]\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{4})\\b`,
        "gi",
      ),
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The key terms of a question, in order: names, numbers and topic words.
 * Numbers such as "$150,000" or "20%" are kept: they usually define the threshold.
 */
export function extractKeyTerms(question: string, maxTerms = 7): string[] {
  const cleaned = stripDeadline(question.replace(/[?!"“”]/g, " "));
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const raw of tokens) {
    const token = raw.replace(/^[^\p{L}\p{N}$€£]+|[^\p{L}\p{N}%]+$/gu, "");
    const key = token.toLowerCase().replace(/'s$/, "");

    if (!token || QUESTION_STOP_WORDS.has(key) || seen.has(key)) {
      continue;
    }

    // Single letters and bare short words add noise, but keep tickers like "US" or "BTC".
    if (token.length < 3 && !/^[A-Z0-9$]{2,}$/.test(token)) {
      continue;
    }

    seen.add(key);
    terms.push(token.replace(/'s$/, ""));

    if (terms.length >= maxTerms) {
      break;
    }
  }

  return terms;
}

/** Capitalised words and acronyms: the likely subject (people, organisations, places, assets). */
export function extractEntities(question: string, maxEntities = 3): string[] {
  const cleaned = stripDeadline(question);
  const words = cleaned.replace(/[?!"“”,]/g, " ").split(/\s+/).filter(Boolean);
  const entities: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      const entity = current.join(" ").replace(/'s$/, "");

      if (!entities.some((e) => e.toLowerCase() === entity.toLowerCase())) {
        entities.push(entity);
      }
    }

    current = [];
  };

  words.forEach((word, index) => {
    const bare = word.replace(/[^\p{L}\p{N}'.&-]/gu, "");
    const isCapitalised = /^[A-Z]/.test(bare);
    const isFirstQuestionWord = index === 0;

    const isMonth = new RegExp(`^(${MONTHS})$`, "i").test(bare);

    if (
      isCapitalised &&
      !isFirstQuestionWord &&
      !isMonth &&
      !QUESTION_STOP_WORDS.has(bare.toLowerCase())
    ) {
      current.push(bare);
    } else {
      flush();
    }
  });

  flush();

  return entities.slice(0, maxEntities);
}

function query(
  text: string,
  objective: string,
  sourceTypes: EvidenceSourceType[],
): ResearchQuery {
  return { query: text.replace(/\s+/g, " ").trim(), objective, sourceTypes };
}

/** Verbs that define the outcome but make poor search subjects. */
const ACTION_WORDS = new Set([
  "close", "beat", "win", "lose", "sign", "release", "launch", "fall",
  "rise", "cut", "hike", "raise", "reach", "pass", "approve", "reject",
  "announce", "exceed", "drop", "hit", "score", "remain", "stay", "leave",
  "join", "resign", "elect", "hold", "trade", "list", "ban",
]);

/**
 * The search subject: up to two entities plus up to two topic words,
 * e.g. "Nigeria annual inflation" rather than just "Nigeria".
 */
export function buildSubject(question: string): string {
  const entities = extractEntities(question, 2);
  const entityWords = new Set(
    entities.flatMap((entity) => entity.toLowerCase().split(" ")),
  );
  const topic = extractKeyTerms(question, 10).filter((term) => {
    const key = term.toLowerCase();

    return (
      !entityWords.has(key) &&
      !ACTION_WORDS.has(key) &&
      !/^[$€£]?[\d.,]+%?$/.test(term) &&
      !new RegExp(`^(${MONTHS})$`, "i").test(term)
    );
  });

  return [...entities, ...topic.slice(0, 2)].join(" ");
}

/** Rule-based queries: short, keyword-focused, with freshness filters. */
export const focusedQueryGenerator: ResearchQueryGenerator = async (
  input: ResearchPlanningInput,
) => {
  const terms = extractKeyTerms(input.marketQuestion);
  const core = terms.join(" ") || input.marketQuestion.slice(0, 80);
  const subject = buildSubject(input.marketQuestion) || terms.slice(0, 3).join(" ");

  const queries: ResearchQuery[] = [
    query(
      `${core} when:7d`,
      "Find news from the past week that the forecaster may not have priced in yet.",
      ["news"],
    ),
    query(
      `${subject} latest when:3d`,
      "Find the most recent developments about the market's subject.",
      ["news"],
    ),
    query(
      core,
      "Find the main reporting on the market question.",
      ["news", "other"],
    ),
    query(
      `${subject} official statement announcement`,
      "Find primary-source statements or announcements from the organisations involved.",
      ["official", "regulatory"],
    ),
    query(
      `${subject} schedule date deadline`,
      "Find scheduled events, votes, releases or deadlines that decide the outcome.",
      ["other", "news"],
    ),
  ];

  for (const source of input.suggestedDataSources.slice(0, 3)) {
    const name = source.trim();

    if (name) {
      queries.push(
        query(
          `"${name}" ${terms.slice(0, 4).join(" ")}`,
          `Find publications from ${name}, a data source named by the market.`,
          ["official"],
        ),
      );
    }
  }

  const unique = new Map<string, ResearchQuery>();

  for (const item of queries) {
    const key = item.query.toLowerCase();

    if (item.query && !unique.has(key)) {
      unique.set(key, item);
    }
  }

  return { queries: [...unique.values()].slice(0, 8) };
};

const VALID_TYPES: EvidenceSourceType[] = ["official", "regulatory", "academic", "news", "other"];

const PLANNER_PROMPT = `You plan web searches for evidence on a Yes/No prediction market.
Return 4 to 6 short search-engine queries (2 to 8 words each, keywords not sentences) that are most likely to find NEW, specific, dated facts that would change the probability: scheduled events, official decisions, filings, data releases, injuries or line-ups, polls, on-chain or price data, local or niche coverage.
Do not repeat the question as a sentence. Do not invent facts.
Reply with JSON only: {"queries": [{"query": "...", "objective": "...", "sourceTypes": ["news" | "official" | "regulatory" | "academic" | "other"]}]}`;

/**
 * LLM query planning with a rule-based fallback.
 *
 * Any failure (no reply, bad JSON, budget used up) falls back to the
 * rule-based plan, so a flaky free model never stops research.
 * The rule-based freshness query is always kept.
 */
export function createLlmQueryGenerator(
  llm: LlmClient,
  fallback: ResearchQueryGenerator = focusedQueryGenerator,
  log: (...args: unknown[]) => void = () => {},
): ResearchQueryGenerator {
  return async (input) => {
    const base = (await fallback(input)) as { queries: ResearchQuery[] };

    let suggested: ResearchQuery[] = [];

    try {
      const reply = (await llm.completeJson([
        { role: "system", content: PLANNER_PROMPT },
        {
          role: "user",
          content:
            `MARKET QUESTION: ${input.marketQuestion}\n` +
            `RESOLUTION CRITERIA: ${input.resolutionCriteria}\n` +
            `SUBMISSION DEADLINE: ${input.evidenceCutoffAt}\n` +
            `DATA SOURCES: ${input.suggestedDataSources.join(", ") || "none listed"}`,
        },
      ])) as { queries?: unknown };

      if (Array.isArray(reply.queries)) {
        suggested = reply.queries
          .filter(
            (item): item is { query: string; objective?: unknown; sourceTypes?: unknown } =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as { query?: unknown }).query === "string",
          )
          .map((item) => {
            const types = Array.isArray(item.sourceTypes)
              ? item.sourceTypes.filter((t): t is EvidenceSourceType =>
                  VALID_TYPES.includes(t as EvidenceSourceType),
                )
              : [];

            return query(
              item.query.slice(0, 120),
              typeof item.objective === "string" && item.objective.trim()
                ? item.objective.trim().slice(0, 200)
                : "LLM-suggested search.",
              types.length > 0 ? types : ["news"],
            );
          })
          .filter((item) => item.query.split(" ").length <= 12);
      }
    } catch (error) {
      log(
        `Query planner fell back to rule-based queries: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Freshness query first, then the LLM's specific queries, then the rest.
    const merged = [base.queries[0], ...suggested, ...base.queries.slice(1)];
    const unique = new Map<string, ResearchQuery>();

    for (const item of merged) {
      const key = item.query.toLowerCase();

      if (!unique.has(key)) {
        unique.set(key, item);
      }
    }

    return { queries: [...unique.values()].slice(0, 8) };
  };
}
