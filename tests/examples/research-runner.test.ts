
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runMarketResearch,
  type ResearchRunnerOptions,
} from "../../examples/evidence-starter/research-runner.js";

import {
  planResearchQueries,
  type ResearchPlan,
  type ResearchPlanningInput,
  type ResearchQueryGenerator,
} from "../../examples/evidence-starter/research-planner.js";

import {
  discoverSources,
  type DiscoveredSource,
  type ResearchSearchProvider,
  type SourceDiscoveryResult,
} from "../../examples/evidence-starter/source-discovery.js";

import {
  assessEvidence,
  type EvidenceAssessment,
  type EvidenceAssessmentModel,
} from "../../examples/evidence-starter/evidence-assessor.js";

// Mock external workflow stages so these tests focus on
// publication-date selection inside runMarketResearch.
vi.mock("../../examples/evidence-starter/research-planner.js", () => ({
  planResearchQueries: vi.fn(),
}));

vi.mock("../../examples/evidence-starter/source-discovery.js", () => ({
  discoverSources: vi.fn(),
}));

vi.mock("../../examples/evidence-starter/evidence-assessor.js", () => ({
  assessEvidence: vi.fn(),
}));

const NOW = Date.parse("2026-11-20T12:00:00Z");

const input: ResearchPlanningInput = {
  marketAddress: "0x1234567890abcdef",
  marketQuestion: "Will Nigeria introduce a new digital banking policy?",
  resolutionCriteria:
    "The Nigerian government must officially announce the policy before the deadline.",
  evidenceCutoffAt: "2026-12-01T23:59:59Z",
  suggestedDataSources: [
    "Central Bank of Nigeria",
    "Reuters",
  ],
};

function createSource(
  publishedAt?: string,
): DiscoveredSource {
  return {
    url: "https://example.com/nigeria-inflation-report",
    title: "Nigeria Inflation Report",
    snippet: "Official report about Nigeria's economy.",
    sourceName: "Example Publisher",
    sourceTypes: [],
    publishedAt,
  } as DiscoveredSource;
}

function createArticleFetcher(
  source: DiscoveredSource,
  content = "The official report provides Nigeria's inflation figures.",
): NonNullable<ResearchRunnerOptions["articleFetcher"]> {
  return vi.fn().mockResolvedValue({
    requestedUrl: source.url,
    finalUrl: source.url,
    title: "Nigeria Inflation Report",
    content,
    contentType: "text/html",
    fetchedAt: "2026-11-20T12:00:00Z",
    publishedAt: "2026-10-15T08:30:00.000Z",
    publicationDateSource: "json-ld:datePublished",
  });
}

function configureMocks(source: DiscoveredSource): void {
  vi.mocked(planResearchQueries).mockResolvedValue({
    queries: ["Nigeria digital banking policy"],
  } as ResearchPlan);

  vi.mocked(discoverSources).mockResolvedValue({
    sources: [source],
  } as SourceDiscoveryResult);

  vi.mocked(assessEvidence).mockResolvedValue(
    {} as EvidenceAssessment,
  );
}

function createRunnerOptions(
  source: DiscoveredSource,
  assessmentModel: EvidenceAssessmentModel,
  content?: string,
): ResearchRunnerOptions {
  return {
    queryGenerator: {} as ResearchQueryGenerator,
    searchProvider: {} as ResearchSearchProvider,
    articleFetcher: createArticleFetcher(source, content),
    assessmentModel,
    now: NOW,
  };
}

describe("research runner publication date selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the article publication date when search metadata is missing", async () => {
    const source = createSource(undefined);

    configureMocks(source);

    const assessmentModel = vi.fn() as EvidenceAssessmentModel;

    const result = await runMarketResearch(
      input,
      createRunnerOptions(source, assessmentModel),
    );

    expect(result.fetchedArticles).toHaveLength(1);
    expect(result.assessments).toHaveLength(1);
    expect(result.assessmentFailures).toHaveLength(0);

    expect(assessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedAt: "2026-10-15T08:30:00.000Z",
        evidenceCutoffAt: input.evidenceCutoffAt,
      }),
      assessmentModel,
    );

    const assessmentInput = vi.mocked(assessEvidence).mock.calls[0][0];

    expect(assessmentInput).not.toHaveProperty("evidenceDate");
  });

  it("prefers the article publication date over search-provider metadata", async () => {
    const source = createSource(
      "2026-11-19T10:00:00Z",
    );

    configureMocks(source);

    const assessmentModel = vi.fn() as EvidenceAssessmentModel;

    const result = await runMarketResearch(
      input,
      createRunnerOptions(source, assessmentModel),
    );

    expect(result.fetchedArticles).toHaveLength(1);
    expect(result.assessments).toHaveLength(1);
    expect(result.assessmentFailures).toHaveLength(0);

    expect(assessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedAt: "2026-10-15T08:30:00.000Z",
        evidenceCutoffAt: input.evidenceCutoffAt,
      }),
      assessmentModel,
    );

    const assessmentInput = vi.mocked(assessEvidence).mock.calls[0][0];

    expect(assessmentInput.publishedAt).not.toBe(
      "2026-11-19T10:00:00Z",
    );
    expect(assessmentInput).not.toHaveProperty("evidenceDate");
  });

  it("passes an extracted event date separately from the publication date", async () => {
    const source = createSource("2026-11-19T10:00:00Z");

    configureMocks(source);

    const assessmentModel = vi.fn() as EvidenceAssessmentModel;

    await runMarketResearch(
      input,
      createRunnerOptions(
        source,
        assessmentModel,
        "The central bank confirmed the policy change on 2 October 2026.",
      ),
    );

    expect(assessEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedAt: "2026-10-15T08:30:00.000Z",
        evidenceDate: "2026-10-02T00:00:00.000Z",
      }),
      assessmentModel,
    );
  });
});

