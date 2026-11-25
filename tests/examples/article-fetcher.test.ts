
import { describe, expect, it, vi } from "vitest";

import {
  fetchArticle,
} from "../../examples/evidence-starter/article-fetcher.js";

function htmlResponse(
  html: string,
  status = 200,
  contentType = "text/html; charset=utf-8",
): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": contentType,
    },
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("article fetcher publication date extraction", () => {
  it("extracts publication date from JSON-LD datePublished", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <title>Nigeria Inflation Report</title>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "NewsArticle",
                "headline": "Nigeria Inflation Report",
                "datePublished": "2026-10-15T09:30:00+01:00",
                "dateModified": "2026-10-20T12:00:00+01:00"
              }
            </script>
          </head>
          <body>
            <article>
              <h1>Nigeria Inflation Report</h1>
              <p>The report contains the latest inflation figures.</p>
            </article>
          </body>
        </html>
      `),
    );

    const result = await fetchArticle(
      "https://example.com/inflation-report",
      { fetch: fetchMock },
    );

    expect(result.publishedAt).toBe(
      "2026-10-15T08:30:00.000Z",
    );

    expect(result.publicationDateSource).toBe(
      "json-ld:datePublished",
    );
  });

  it("extracts publication date from article:published_time metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <title>Economic Update</title>
            <meta
              property="article:published_time"
              content="2026-10-15T09:30:00+01:00"
            />
          </head>
          <body>
            <article>
              <h1>Economic Update</h1>
              <p>The government released an economic update.</p>
            </article>
          </body>
        </html>
      `),
    );

    const result = await fetchArticle(
      "https://example.com/economic-update",
      { fetch: fetchMock },
    );

    expect(result.publishedAt).toBe(
      "2026-10-15T08:30:00.000Z",
    );

    expect(result.publicationDateSource).toBe(
      "meta:article:published_time",
    );
  });

  it("does not treat dateModified as the publication date", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "NewsArticle",
                "headline": "Economic Update",
                "dateModified": "2026-10-20T12:00:00Z"
              }
            </script>
          </head>
          <body>
            <article>
              <h1>Economic Update</h1>
              <p>The government released an economic update.</p>
            </article>
          </body>
        </html>
      `),
    );

    const result = await fetchArticle(
      "https://example.com/economic-update",
      { fetch: fetchMock },
    );

    expect(result.publishedAt).toBeUndefined();
    expect(result.publicationDateSource).toBeUndefined();
  });

  it("ignores invalid publication-date metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <meta
              property="article:published_time"
              content="not-a-valid-date"
            />
          </head>
          <body>
            <article>
              <h1>Economic Update</h1>
              <p>The government released an economic update.</p>
            </article>
          </body>
        </html>
      `),
    );

    const result = await fetchArticle(
      "https://example.com/economic-update",
      { fetch: fetchMock },
    );

    expect(result.publishedAt).toBeUndefined();
    expect(result.publicationDateSource).toBeUndefined();
  });

  it("returns no publication date when the page has no date metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <title>Economic Update</title>
          </head>
          <body>
            <article>
              <h1>Economic Update</h1>
              <p>The government released an economic update.</p>
            </article>
          </body>
        </html>
      `),
    );

    const result = await fetchArticle(
      "https://example.com/economic-update",
      { fetch: fetchMock },
    );

    expect(result.publishedAt).toBeUndefined();
    expect(result.publicationDateSource).toBeUndefined();
  });
});

describe("article fetcher URL validation", () => {
  it.each([
    "http://example.com/article",
    "https://localhost/article",
    "https://127.0.0.1/article",
    "https://192.168.1.10/article",
    "https://192.0.0.1/article",
    "https://192.88.99.1/article",
    "https://198.51.100.1/article",
    "https://203.0.113.1/article",
    "https://224.0.0.1/article",
    "https://240.0.0.1/article",
    "https://[::1]/article",
    "https://[fc00::1]/article",
    "https://[fe80::1]/article",
    "https://[2001:db8::1]/article",
    "https://user:password@example.com/article",
  ])("rejects unsafe URL: %s", async (url) => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      fetchArticle(url, { fetch: fetchMock }),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a redirect to a private IP address", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://127.0.0.1/private",
        },
      }),
    );

    await expect(
      fetchArticle("https://example.com/article", {
        fetch: fetchMock,
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to another valid public URL", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://example.org/final-article",
          },
        }),
      )
      .mockResolvedValueOnce(
        htmlResponse(`
          <html>
            <head>
              <title>Redirected Article</title>
            </head>
            <body>
              <article>
                <h1>Redirected Article</h1>
                <p>This is the final article content.</p>
              </article>
            </body>
          </html>
        `),
      );

    const result = await fetchArticle(
      "https://example.com/article",
      { fetch: fetchMock },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.finalUrl).toBe(
      "https://example.org/final-article",
    );
    expect(result.title).toBe("Redirected Article");
  });
});

describe("article fetcher response handling", () => {
  it("rejects unsuccessful HTTP 404 responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Not found", {
        status: 404,
        headers: {
          "content-type": "text/html",
        },
      }),
    );

    await expect(
      fetchArticle("https://example.com/missing", {
        fetch: fetchMock,
      }),
    ).rejects.toThrow("HTTP 404");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsuccessful HTTP 500 responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
        headers: {
          "content-type": "text/html",
        },
      }),
    );

    await expect(
      fetchArticle("https://example.com/article", {
        fetch: fetchMock,
      }),
    ).rejects.toThrow("HTTP 500");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported content types", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("PDF content", {
        status: 200,
        headers: {
          "content-type": "application/pdf",
        },
      }),
    );

    await expect(
      fetchArticle("https://example.com/article", {
        fetch: fetchMock,
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects responses exceeding the declared content-length limit", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<html><body>Small response</body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-length": "5000",
        },
      }),
    );

    await expect(
      fetchArticle("https://example.com/large", {
        fetch: fetchMock,
        maxBytes: 100,
      }),
    ).rejects.toThrow("Article response exceeds the size limit");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects streamed responses exceeding the size limit without content-length", async () => {
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`
            <html>
              <body>
                This article body is deliberately larger than the configured limit.
              </body>
            </html>
          `),
        );

        controller.close();
      },
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      }),
    );

    await expect(
      fetchArticle("https://example.com/large-stream", {
        fetch: fetchMock,
        maxBytes: 30,
      }),
    ).rejects.toThrow("Article response exceeds the size limit");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects requests that exceed the configured timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (!signal) {
            reject(new Error("Expected an abort signal"));
            return;
          }

          signal.addEventListener(
            "abort",
            () => {
              reject(
                new DOMException(
                  "The operation was aborted",
                  "AbortError",
                ),
              );
            },
            { once: true },
          );
        }),
    );

    await expect(
      fetchArticle("https://example.com/slow", {
        fetch: fetchMock,
        timeoutMs: 10,
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const signal = fetchMock.mock.calls[0]?.[1]?.signal;

    expect(signal?.aborted).toBe(true);
  });
});

describe("article fetcher content extraction", () => {
  it("extracts the article title and main content from HTML", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <title>Nigeria Economic Growth Report</title>
          </head>
          <body>
            <article>
              <h1>Nigeria Economic Growth Report</h1>
              <p>
                Nigeria's economy recorded significant growth
                during the reporting period.
              </p>
              <p>
                The manufacturing and services sectors
                contributed to the improvement.
              </p>
            </article>
          </body>
        </html>
      `),
    );

    const result = await fetchArticle(
      "https://example.com/economic-growth",
      { fetch: fetchMock },
    );

    const content = normalizeWhitespace(result.content);

    expect(result.title).toBe(
      "Nigeria Economic Growth Report",
    );

    expect(content).toContain(
      "Nigeria's economy recorded significant growth",
    );

    expect(content).toContain(
      "manufacturing and services sectors",
    );
  });

  it("uses the main heading as a title fallback", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head></head>
          <body>
            <article>
              <h1>Central Bank Monetary Policy Update</h1>
              <p>
                The central bank announced a new monetary
                policy decision today.
              </p>
            </article>
          </body>
        </html>
      `),
    );

    const result = await fetchArticle(
      "https://example.com/monetary-policy",
      { fetch: fetchMock },
    );

    const content = normalizeWhitespace(result.content);

    expect(result.title).toBe(
      "Central Bank Monetary Policy Update",
    );

    expect(content).toContain(
      "new monetary policy decision",
    );
  });

  it("excludes navigation, footer, and script content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <title>Government Economic Announcement</title>
            <script>
              const secret = "SCRIPT_CONTENT_SHOULD_NOT_APPEAR";
            </script>
          </head>
          <body>
            <nav>
              NAVIGATION_CONTENT_SHOULD_NOT_APPEAR
            </nav>

            <article>
              <h1>Government Economic Announcement</h1>
              <p>
                The government announced a new economic
                development programme.
              </p>
              <p>
                The programme will support local businesses
                and improve economic productivity.
              </p>
            </article>

            <footer>
              FOOTER_CONTENT_SHOULD_NOT_APPEAR
            </footer>
          </body>
        </html>
      `),
    );

    const result = await fetchArticle(
      "https://example.com/government-announcement",
      { fetch: fetchMock },
    );

    const content = normalizeWhitespace(result.content);

    expect(content).toContain(
      "new economic development programme",
    );

    expect(content).not.toContain(
      "NAVIGATION_CONTENT_SHOULD_NOT_APPEAR",
    );

    expect(content).not.toContain(
      "FOOTER_CONTENT_SHOULD_NOT_APPEAR",
    );

    expect(content).not.toContain(
      "SCRIPT_CONTENT_SHOULD_NOT_APPEAR",
    );
  });

  it("extracts plain-text article content", async () => {
    const articleText = `
      Nigeria Economic Outlook

      Nigeria's economy is expected to grow during the
      next reporting period.

      The agricultural and manufacturing sectors are
      expected to contribute to this growth.
    `;

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(articleText, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      }),
    );

    const result = await fetchArticle(
      "https://example.com/economic-outlook",
      { fetch: fetchMock },
    );

    const content = normalizeWhitespace(result.content);

    expect(content).toContain(
      "Nigeria's economy is expected to grow",
    );

    expect(content).toContain(
      "agricultural and manufacturing sectors",
    );

    expect(result.title).toBe("");
  });

  it("rejects HTML pages without usable article content", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <title>Empty Article</title>
          </head>
          <body>
            <article></article>
          </body>
        </html>
      `),
    );

    await expect(
      fetchArticle("https://example.com/empty-article", {
        fetch: fetchMock,
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects pages containing only navigation and boilerplate", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      htmlResponse(`
        <html>
          <head>
            <title>Website</title>
          </head>
          <body>
            <nav>
              Home
              About
              Contact
              Services
            </nav>

            <footer>
              Copyright 2026
              All rights reserved
            </footer>
          </body>
        </html>
      `),
    );

    await expect(
      fetchArticle("https://example.com/boilerplate", {
        fetch: fetchMock,
      }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

