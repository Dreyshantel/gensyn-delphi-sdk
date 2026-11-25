
import { describe, expect, it, vi } from "vitest";

import {
  createGoogleNewsRssProvider,
  parseGoogleNewsRss,
  resolveGoogleNewsArticleUrl,
} from "../../examples/evidence-starter/google-news-provider.js";

import type { ResearchQuery } from "../../examples/evidence-starter/research-planner.js";

const query: ResearchQuery = {
  query: "Nigeria digital banking policy",
  objective: "Find official policy announcements",
  sourceTypes: ["official", "regulatory"],
};

const sampleXml = `
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Nigeria announces banking policy update</title>
      <link>https://news.google.com/rss/articles/example-one</link>
      <description>Government announces a policy update.</description>
      <source url="https://example.gov.ng">Example Government</source>
      <pubDate>Fri, 20 Nov 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Banking industry responds to new policy</title>
      <link>https://news.google.com/rss/articles/example-two</link>
      <description>Industry stakeholders respond.</description>
      <source url="https://example-news.com">Example News</source>
      <pubDate>Fri, 20 Nov 2026 11:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
`;

const publisherUrls = {
  "example-one": "https://example.gov.ng/news/banking-policy",
  "example-two": "https://example-news.com/articles/banking-response",
};

function googleNewsPage(articleId: string): Response {
  return new Response(
    `
      <html>
        <body>
          <div
            data-n-a-id="${articleId}"
            data-n-a-ts="1795170000"
            data-n-a-sg="test-signature-${articleId}"
          ></div>
        </body>
      </html>
    `,
    {
      status: 200,
      headers: { "Content-Type": "text/html" },
    },
  );
}

function decodeResponse(publisherUrl: string): Response {
  const decodedPayload = JSON.stringify([
    "garturlres",
    publisherUrl,
    1,
  ]);

  const frames = [
    [
      "wrb.fr",
      "Fbv4je",
      decodedPayload,
      null,
      null,
      null,
      null,
    ],
  ];

  return new Response(
    `)]}'\n\n${JSON.stringify(frames)}`,
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function createProviderFetchMock(
  options: {
    failArticleOne?: boolean;
    blockArticleOne?: boolean;
  } = {},
) {
  return vi.fn(
    async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const requestedUrl = new URL(input.toString());

      if (
        requestedUrl.hostname === "news.google.com" &&
        requestedUrl.pathname === "/rss/search"
      ) {
        return new Response(sampleXml, { status: 200 });
      }

      if (requestedUrl.pathname.includes("/articles/")) {
        const articleId = requestedUrl.pathname.split("/").pop() ?? "";

        if (articleId === "example-one" && options.blockArticleOne) {
          return new Response("Blocked", { status: 403 });
        }

        if (articleId === "example-one" && options.failArticleOne) {
          return new Response("Unavailable", { status: 503 });
        }

        return googleNewsPage(articleId);
      }

      if (requestedUrl.pathname.includes("batchexecute")) {
        const requestBody = String(init?.body ?? "");

        if (requestBody.includes("example-one")) {
          return decodeResponse(publisherUrls["example-one"]);
        }

        if (requestBody.includes("example-two")) {
          return decodeResponse(publisherUrls["example-two"]);
        }
      }

      throw new Error(`Unexpected test request: ${requestedUrl}`);
    },
  );
}

describe("Google News RSS provider", () => {
  it("extracts RSS article results", () => {
    const results = parseGoogleNewsRss(sampleXml, query);

    expect(results).toHaveLength(2);
  });

  it("extracts article titles and links", () => {
    const results = parseGoogleNewsRss(sampleXml, query);

    expect(results[0]).toMatchObject({
      title: "Nigeria announces banking policy update",
      url: "https://news.google.com/rss/articles/example-one",
      sourceName: "Example Government",
    });
  });

  it("extracts publication dates", () => {
    const results = parseGoogleNewsRss(sampleXml, query);

    expect(results[0]).toHaveProperty(
      "publishedAt",
      "2026-11-20T10:00:00.000Z",
    );
  });

  it("decodes XML entities", () => {
    const xml = `
      <rss><channel><item>
        <title>Government &amp; Banking Policy</title>
        <link>https://news.google.com/example</link>
        <source>Example News</source>
      </item></channel></rss>
    `;

    const results = parseGoogleNewsRss(xml, query);

    expect(results[0]).toMatchObject({
      title: "Government & Banking Policy",
    });
  });

  it("handles CDATA content", () => {
    const xml = `
      <rss><channel><item>
        <title><![CDATA[Banking policy update]]></title>
        <link>https://news.google.com/example</link>
        <source><![CDATA[Example News]]></source>
      </item></channel></rss>
    `;

    const results = parseGoogleNewsRss(xml, query);

    expect(results[0]).toMatchObject({
      title: "Banking policy update",
      sourceName: "Example News",
    });
  });

  it("ignores incomplete RSS items", () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Missing source and link</title>
        </item>
        <item>
          <title>Valid article</title>
          <link>https://news.google.com/example</link>
          <source>Example News</source>
        </item>
      </channel></rss>
    `;

    const results = parseGoogleNewsRss(xml, query);

    expect(results).toHaveLength(1);
  });

  it("limits the number of parsed results", () => {
    const results = parseGoogleNewsRss(sampleXml, query, 1);

    expect(results).toHaveLength(1);
  });

  it("rejects invalid result limits", () => {
    expect(() => parseGoogleNewsRss(sampleXml, query, 0)).toThrow();
    expect(() => parseGoogleNewsRss(sampleXml, query, 51)).toThrow();
  });

  it("resolves a Google News URL to the publisher URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(googleNewsPage("example-one"))
      .mockResolvedValueOnce(
        decodeResponse(publisherUrls["example-one"]),
      );

    const result = await resolveGoogleNewsArticleUrl(
      "https://news.google.com/rss/articles/example-one",
      { fetch: fetchMock },
    );

    expect(result).toBe(publisherUrls["example-one"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
    });
  });

  it("rejects a Google News page without decoding attributes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html><title>Google News</title></html>", {
        status: 200,
      }),
    );

    await expect(
      resolveGoogleNewsArticleUrl(
        "https://news.google.com/rss/articles/example-one",
        { fetch: fetchMock },
      ),
    ).rejects.toThrow("required decoding parameters");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed decoding response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(googleNewsPage("example-one"))
      .mockResolvedValueOnce(
        new Response("Invalid response", { status: 200 }),
      );

    await expect(
      resolveGoogleNewsArticleUrl(
        "https://news.google.com/rss/articles/example-one",
        { fetch: fetchMock },
      ),
    ).rejects.toThrow();
  });

  it("rejects a non-HTTPS publisher URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(googleNewsPage("example-one"))
      .mockResolvedValueOnce(
        decodeResponse("http://example.gov.ng/article"),
      );

    await expect(
      resolveGoogleNewsArticleUrl(
        "https://news.google.com/rss/articles/example-one",
        { fetch: fetchMock },
      ),
    ).rejects.toThrow("valid publisher URL");
  });

  it("creates a valid Google News RSS request", async () => {
    const fetchMock = createProviderFetchMock();

    const provider = createGoogleNewsRssProvider({
      fetch: fetchMock,
    });

    await provider(query);

    expect(fetchMock).toHaveBeenCalledTimes(5);

    const requestedUrl = new URL(
      fetchMock.mock.calls[0][0].toString(),
    );

    expect(requestedUrl.hostname).toBe("news.google.com");
    expect(requestedUrl.searchParams.get("q")).toBe(query.query);
    expect(requestedUrl.searchParams.get("gl")).toBe("NG");
  });

  it("returns resolved publisher URLs through the provider", async () => {
    const fetchMock = createProviderFetchMock();

    const provider = createGoogleNewsRssProvider({
      fetch: fetchMock,
    });

    const results = await provider(query) as Array<{
      title: string;
      url: string;
      sourceName: string;
      publishedAt?: string;
    }>;

    expect(results).toHaveLength(2);

    expect(results[0]).toMatchObject({
      title: "Nigeria announces banking policy update",
      url: publisherUrls["example-one"],
      sourceName: "Example Government",
      publishedAt: "2026-11-20T10:00:00.000Z",
    });

    expect(results[1]).toMatchObject({
      title: "Banking industry responds to new policy",
      url: publisherUrls["example-two"],
      sourceName: "Example News",
    });
  });

  it("skips an individual article failure and continues resolving other articles", async () => {
    const fetchMock = createProviderFetchMock({
      failArticleOne: true,
    });

    const provider = createGoogleNewsRssProvider({
      fetch: fetchMock,
    });

    const results = await provider(query) as Array<{
      url: string;
      sourceName: string;
    }>;

    expect(results).toHaveLength(1);

    expect(results[0].url).toBe(publisherUrls["example-two"]);
    expect(results[0].sourceName).toBe("Example News");

    // RSS request + failed first article + second article page + decode.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("stops resolving articles when Google blocks automated requests", async () => {
    const fetchMock = createProviderFetchMock({
      blockArticleOne: true,
    });

    const provider = createGoogleNewsRssProvider({
      fetch: fetchMock,
    });

    const results = await provider(query);

    expect(results).toHaveLength(0);

    // RSS request + first article request.
    // The second article must not be attempted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the RSS endpoint returns an HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Unavailable", { status: 503 }),
    );

    const provider = createGoogleNewsRssProvider({
      fetch: fetchMock,
    });

    await expect(provider(query)).rejects.toThrow("HTTP 503");
  });

  it("throws when the RSS response is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", { status: 200 }),
    );

    const provider = createGoogleNewsRssProvider({
      fetch: fetchMock,
    });

    await expect(provider(query)).rejects.toThrow("empty response");
  });

  it("rejects invalid provider configuration", () => {
    expect(() =>
      createGoogleNewsRssProvider({ maxResults: 0 }),
    ).toThrow();

    expect(() =>
      createGoogleNewsRssProvider({ timeoutMs: 0 }),
    ).toThrow();
  });
});

