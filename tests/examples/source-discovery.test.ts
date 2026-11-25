
import { describe, expect, it, vi } from "vitest";

import {
  discoverSources,
  type ResearchSearchProvider,
} from "../../examples/evidence-starter/source-discovery.js";

import type {
  ResearchQuery,
} from "../../examples/evidence-starter/research-planner.js";

const queries: ResearchQuery[] = [
  {
    query: "Nigeria digital banking policy",
    objective: "Find official policy announcements",
    sourceTypes: ["official"],
  },
  {
    query: "Nigeria banking regulatory updates",
    objective: "Find regulatory publications",
    sourceTypes: ["regulatory"],
  },
];

const validResult = {
  title: "New Banking Policy Announcement",
  url: "https://example.com/banking-policy",
  sourceName: "Example Government",
  snippet: "A summary of the announcement.",
  publishedAt: "2026-11-20T10:00:00Z",
};

describe("source discovery", () => {
 it("collects valid search results from multiple queries", async () => {
  const provider = vi.fn()
    .mockResolvedValueOnce([validResult])
    .mockResolvedValueOnce([
      {
        ...validResult,
        title: "Another Banking Policy Report",
        url: "https://example.com/another-banking-report",
        sourceName: "Example News",
      },
    ]);

  const result = await discoverSources(queries, provider);

  expect(result.sources).toHaveLength(2);
  expect(result.failures).toHaveLength(0);
});
 
  it("records the originating research query", async () => {
    const provider = vi.fn().mockResolvedValue([validResult]);

    const result = await discoverSources([queries[0]], provider);

    expect(result.sources[0].originatingQuery).toBe(
      queries[0].query,
    );
  });

  it("rejects HTTP URLs", async () => {
    const provider = vi.fn().mockResolvedValue([
      {
        ...validResult,
        url: "http://example.com/article",
      },
    ]);

    const result = await discoverSources([queries[0]], provider);

    expect(result.sources).toHaveLength(0);
    expect(result.rejectedResults).toBe(1);
  });

  it("rejects malformed URLs", async () => {
    const provider = vi.fn().mockResolvedValue([
      {
        ...validResult,
        url: "not-a-valid-url",
      },
    ]);

    const result = await discoverSources([queries[0]], provider);

    expect(result.sources).toHaveLength(0);
    expect(result.rejectedResults).toBe(1);
  });

  it("rejects results with missing required fields", async () => {
    const provider = vi.fn().mockResolvedValue([
      {
        title: "Missing source name",
        url: validResult.url,
      },
    ]);

    const result = await discoverSources([queries[0]], provider);

    expect(result.sources).toHaveLength(0);
    expect(result.rejectedResults).toBe(1);
  });

  it("rejects invalid publication dates", async () => {
    const provider = vi.fn().mockResolvedValue([
      {
        ...validResult,
        publishedAt: "not-a-date",
      },
    ]);

    const result = await discoverSources([queries[0]], provider);

    expect(result.sources).toHaveLength(0);
    expect(result.rejectedResults).toBe(1);
  });

  it("removes duplicate URLs across queries", async () => {
    const provider = vi.fn().mockResolvedValue([validResult]);

    const result = await discoverSources(queries, provider);

    expect(result.sources).toHaveLength(1);
  });

  it("removes URL fragments when detecting duplicates", async () => {
    const provider: ResearchSearchProvider = vi
      .fn()
      .mockResolvedValueOnce([
        validResult,
      ])
      .mockResolvedValueOnce([
        {
          ...validResult,
          url: `${validResult.url}#section`,
        },
      ]);

    const result = await discoverSources(queries, provider);

    expect(result.sources).toHaveLength(1);
  });

  it("limits results per query", async () => {
    const provider = vi.fn().mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        ...validResult,
        url: `https://example.com/article-${index}`,
      })),
    );

    const result = await discoverSources(
      [queries[0]],
      provider,
      { maxResultsPerQuery: 2 },
    );

    expect(result.sources).toHaveLength(2);
  });

  it("limits the total number of results", async () => {
    const provider = vi.fn().mockImplementation(
      async (query: ResearchQuery) => [
        {
          ...validResult,
          url: `https://example.com/${encodeURIComponent(query.query)}`,
        },
      ],
    );

    const result = await discoverSources(
      queries,
      provider,
      { maxTotalResults: 1 },
    );

    expect(result.sources).toHaveLength(1);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("continues when one query fails", async () => {
    const provider: ResearchSearchProvider = vi
      .fn()
      .mockRejectedValueOnce(new Error("Search unavailable"))
      .mockResolvedValueOnce([validResult]);

    const result = await discoverSources(queries, provider);

    expect(result.failures).toHaveLength(1);
    expect(result.sources).toHaveLength(1);
  });

  it("records invalid provider responses", async () => {
    const provider = vi.fn().mockResolvedValue("invalid response");

    const result = await discoverSources([queries[0]], provider);

    expect(result.failures).toHaveLength(1);
  });

  it("rejects an invalid per-query result limit", async () => {
    const provider = vi.fn();

    await expect(
      discoverSources(queries, provider, {
        maxResultsPerQuery: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects an invalid total result limit", async () => {
    const provider = vi.fn();

    await expect(
      discoverSources(queries, provider, {
        maxTotalResults: 101,
      }),
    ).rejects.toThrow();
  });
});

