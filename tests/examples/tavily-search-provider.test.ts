
import { describe, expect, it, vi } from "vitest";

import {
  createTavilySearchProvider,
  parseTavilySearchResponse,
} from "../../examples/evidence-starter/tavily-search-provider.js";

import type { ResearchQuery } from "../../examples/evidence-starter/research-planner.js";

const query: ResearchQuery = {
  query: "Nigeria inflation November 2026 NBS CPI report",
  objective: "Find official inflation statistics",
  sourceTypes: ["official", "regulatory"],
};

const sampleResponse = {
  query: query.query,
  results: [
    {
      title: "Nigeria inflation report November 2026",
      url: "https://www.nigerianstat.gov.ng/report/inflation",
      content: "The annual inflation rate changed during November 2026.",
      score: 0.95,
      published_date: "2026-11-20",
    },
    {
      title: "Central Bank monetary policy update",
      url: "https://www.cbn.gov.ng/news/policy-update",
      content: "The Central Bank announced a monetary policy update.",
      score: 0.89,
      published_date: "2026-11-19",
    },
  ],
  response_time: 0.8,
};

function createFetchMock(
  response: unknown = sampleResponse,
  status = 200,
) {
  return vi.fn(
    async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      return new Response(
        JSON.stringify(response),
        {
          status,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    },
  );
}

describe("Tavily search provider", () => {
  describe("parseTavilySearchResponse", () => {
    it("extracts search results", () => {
      const results = parseTavilySearchResponse(
        sampleResponse,
        query,
      );

      expect(results).toHaveLength(2);
    });

    it("maps Tavily fields to the discovery format", () => {
      const results = parseTavilySearchResponse(
        sampleResponse,
        query,
      );

      expect(results[0]).toMatchObject({
        title: "Nigeria inflation report November 2026",
        url: "https://www.nigerianstat.gov.ng/report/inflation",
        sourceName: "nigerianstat.gov.ng",
        snippet: "The annual inflation rate changed during November 2026.",
        publishedAt: "2026-11-20T00:00:00.000Z",
      });
    });

    it("normalises publisher hostnames", () => {
      const results = parseTavilySearchResponse(
        sampleResponse,
        query,
      );

      expect(results[0]).toHaveProperty(
        "sourceName",
        "nigerianstat.gov.ng",
      );
    });

    it("omits invalid publication dates", () => {
      const response = {
        results: [
          {
            title: "Example report",
            url: "https://example.com/report",
            content: "Example content",
            published_date: "not-a-date",
          },
        ],
      };

      const results = parseTavilySearchResponse(
        response,
        query,
      );

      expect(results[0]).not.toHaveProperty("publishedAt");
    });

    it("rejects malformed response envelopes", () => {
      expect(() =>
        parseTavilySearchResponse(
          { results: "invalid" },
          query,
        ),
      ).toThrow("invalid search response");
    });

    it("rejects invalid result limits", () => {
      expect(() =>
        parseTavilySearchResponse(
          sampleResponse,
          query,
          0,
        ),
      ).toThrow();

      expect(() =>
        parseTavilySearchResponse(
          sampleResponse,
          query,
          21,
        ),
      ).toThrow();
    });

    it("ignores incomplete search results", () => {
      const response = {
        results: [
          {
            title: "Incomplete result",
            url: "https://example.com",
          },
          {
            title: "Valid result",
            url: "https://example.com/report",
            content: "Valid content",
          },
        ],
      };

      const results = parseTavilySearchResponse(
        response,
        query,
      );

      expect(results).toHaveLength(1);
    });

    it("respects the maximum result count", () => {
      const results = parseTavilySearchResponse(
        sampleResponse,
        query,
        1,
      );

      expect(results).toHaveLength(1);
    });
  });

  describe("createTavilySearchProvider", () => {
    it("requires an API key", () => {
      expect(() =>
        createTavilySearchProvider({
          apiKey: "",
        }),
      ).toThrow("TAVILY_API_KEY is required");
    });

    it("rejects invalid configuration", () => {
      expect(() =>
        createTavilySearchProvider({
          apiKey: "test-key",
          maxResults: 21,
        }),
      ).toThrow("maxResults");

      expect(() =>
        createTavilySearchProvider({
          apiKey: "test-key",
          timeoutMs: 0,
        }),
      ).toThrow("timeoutMs");
    });

    it("sends a valid Tavily search request", async () => {
      const fetchMock = createFetchMock();

      const provider = createTavilySearchProvider({
        apiKey: "test-tavily-key",
        fetch: fetchMock,
      });

      const results = await provider(query);

      expect(results).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];

      expect(url).toBe(
        "https://api.tavily.com/search",
      );

      expect(init).toMatchObject({
        method: "POST",
        headers: {
          Authorization: "Bearer test-tavily-key",
          "Content-Type": "application/json",
        },
      });

      expect(JSON.parse(String(init?.body))).toEqual({
        query: query.query,
        search_depth: "basic",
        topic: "general",
        max_results: 10,
        include_answer: false,
        include_raw_content: false,
      });
    });

    it("supports custom search configuration", async () => {
      const fetchMock = createFetchMock();

      const provider = createTavilySearchProvider({
        apiKey: "test-key",
        fetch: fetchMock,
        maxResults: 5,
        searchDepth: "advanced",
        topic: "news",
      });

      await provider(query);

      const init = fetchMock.mock.calls[0][1];

      expect(JSON.parse(String(init?.body))).toMatchObject({
        max_results: 5,
        search_depth: "advanced",
        topic: "news",
      });
    });

    it("throws when Tavily returns an HTTP error", async () => {
      const fetchMock = createFetchMock(
        { error: "Unauthorized" },
        401,
      );

      const provider = createTavilySearchProvider({
        apiKey: "invalid-key",
        fetch: fetchMock,
      });

      await expect(provider(query)).rejects.toThrow(
        "Tavily search failed (HTTP 401)",
      );
    });

    it("rejects invalid JSON responses", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response("not-json", {
          status: 200,
        }),
      );

      const provider = createTavilySearchProvider({
        apiKey: "test-key",
        fetch: fetchMock,
      });

      await expect(provider(query)).rejects.toThrow(
        "invalid JSON response",
      );
    });

    it("rejects malformed Tavily response data", async () => {
      const fetchMock = createFetchMock({
        results: "not-an-array",
      });

      const provider = createTavilySearchProvider({
        apiKey: "test-key",
        fetch: fetchMock,
      });

      await expect(provider(query)).rejects.toThrow(
        "invalid search response",
      );
    });
  });
});

