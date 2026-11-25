// Shapes returned by examples/evidence-starter/dashboard-api.ts.

export type Direction = "yes" | "no";

export interface Overview {
  config: {
    agentId: string;
    llmModel: string | null;
    hasApiClient: boolean;
    hasSiteUrl: boolean;
    acceptTermsVersion?: string;
  };
  prize: {
    judged: number;
    judgedNeeded: number;
    markets: number;
    marketsNeeded: number;
    qualified: boolean;
  };
  rewards: { held: number; paid: number; voided: number };
  counts: {
    submissions: number;
    pending: number;
    awaitingVerdict: number;
    rejected: number;
    waitingForReview: number;
  };
  run: { status: RunStatus; startedAt: string | null; finishedAt: string | null };
  latestRun: { id: string; kind: string; finishedAt: string; metrics: RunMetrics; warnings: string[] } | null;
}

export interface Candidate {
  marketAddress: string;
  marketQuestion: string;
  marketStatus: string;
  evidenceCutoffAt: string;
  direction?: Direction;
  fact: string;
  asOfDate: string;
  quote: string;
  sourceUrl: string;
  publisher: string;
  publishedAt?: string;
  rationale: string;
  confidence: number;
}

export interface QueueItem {
  id: string;
  addedAt: string;
  candidate: Candidate;
  note: string;
  eligible: boolean;
  blockedBy: string[];
}

export interface SubmissionRecord {
  idempotencyKey: string;
  marketAddress: string;
  marketQuestion: string;
  direction: Direction;
  fact: string;
  asOfDate: string;
  sourceUrl: string;
  publisher: string;
  note: string;
  status: string;
  submissionId?: string;
  createdAt: string;
  verdict?: string | null;
  reason?: string | null;
  bounty?: { amount: string; state: string } | null;
  zeroPayReason?: string;
  lastError?: string;
}

export type RunStatus = "idle" | "running" | "done" | "failed";

export interface RunState {
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  candidatesAdded: number;
  error: string | null;
  log: string[];
}

export interface Terms {
  available: boolean;
  version?: string;
  url?: string;
  acceptedAt?: string | null;
  acceptTermsVersion?: string | null;
}

// ---- Run records (examples/evidence-starter/run-record.ts) ----

export type Relationship = "direct_support" | "contradiction" | "context" | "irrelevant" | "inconclusive";
export type CredibilityTier = "primary" | "established" | "unknown" | "low";
export type FindingStatus =
  | "candidate"
  | "duplicate_fact"
  | "non_directional"
  | "failed_checks"
  | "syndicated_copy"
  | "screened_out"
  | "not_selected"
  | "needs_primary_source"
  | "already_submitted"
  | "budget_exhausted";

export interface ScoreParts {
  impact: number;
  credibility: number;
  freshness: number;
  specificity: number;
  relevance: number;
}

export interface Finding {
  id: string;
  marketAddress: string;
  marketQuestion: string;
  status: FindingStatus;
  reasons: string[];
  url: string;
  title: string;
  publisher: string;
  publishedAt?: string;
  publishedAtSource?: "page" | "search";
  credibility: CredibilityTier;
  ruleRelevance: number;
  ruleRelationship: Relationship;
  relationship?: Relationship;
  direction?: Direction;
  fact?: string;
  asOfDate?: string;
  quote?: string;
  rationale?: string;
  limitations?: string[];
  confidence?: number;
  valueScore?: number;
  scoreParts?: ScoreParts;
  duplicateOf?: string;
  corroboratedBy?: { url: string; title: string; publisher: string; credibility: CredibilityTier; via: "fetched" | "search" };
}

export interface MarketSpec {
  subject: string;
  event: string;
  measurableOutcome: string;
  deadline: string;
  geography: string;
  clarity: "clear" | "ambiguous";
  notes: string;
}

export interface MarketRun {
  address: string;
  question: string;
  status: string;
  yesProbability: number;
  evidenceCutoffAt: string;
  dataSources: string[];
  criteria: string | null;
  criteriaSource: "supplied" | "question" | "none";
  spec?: MarketSpec;
  researched: boolean;
  skipReason?: string;
  research?: {
    queries: string[];
    sourcesFound: number;
    publishers: number;
    searchFailures: { query: string; reason: string }[];
    fetched: number;
    fetchFailures: { url: string; reason: string }[];
    assessed: number;
  };
  findingCount: number;
  candidateCount: number;
}

export interface RunMetrics {
  marketsDiscovered: number;
  marketsOpen: number;
  marketsResearched: number;
  researchFailures: number;
  sourcesFound: number;
  articlesFetched: number;
  fetchFailures: number;
  fetchSuccessRate: number | null;
  articlesAssessed: number;
  articlesSentToLlm: number;
  candidates: number;
  candidateRate: number | null;
  hallucinationsCaught: number;
  duplicateRate: number | null;
  findingsByStatus: Partial<Record<FindingStatus, number>>;
  relationships: Partial<Record<Relationship, number>>;
  candidateCredibility: Partial<Record<CredibilityTier, number>>;
  averageValueScore: number | null;
  llmCalls: number;
  llmTokens: number | null;
  durationMs: number;
}

export interface RunSummary {
  id: string;
  kind: "mine" | "live-check";
  mode: string;
  startedAt: string;
  finishedAt: string;
  llm: { model: string; calls: number; usage?: { totalTokens: number; rateLimitWaits: number } } | null;
  searchProviders: string[];
  metrics: RunMetrics;
  warnings: string[];
}

export interface RunRecord extends RunSummary {
  markets: MarketRun[];
  findings: Finding[];
}

export type Settings = Record<string, Record<string, string | number | boolean | string[] | null>>;
