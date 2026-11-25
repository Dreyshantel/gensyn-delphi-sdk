
import type { ResearchQuery } from "./research-planner.js";
import type { ResearchSearchProvider } from "./source-discovery.js";

export interface GoogleNewsRssOptions {
  fetch?: typeof fetch;
  maxResults?: number;
  timeoutMs?: number;
  /**
   * Google News edition. Default: Nigeria/English (`en-NG`, `NG`).
   * Use `{ hl: "en-US", gl: "US" }` for US and global markets.
   */
  edition?: { hl: string; gl: string };
}

interface GoogleNewsArticle {
  title: string;
  url: string;
  sourceName: string;
  snippet?: string;
  publishedAt?: string;
}

interface GoogleNewsDecodeParams {
  articleId: string;
  timestamp: string;
  signature: string;
}

class GoogleNewsAccessBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleNewsAccessBlockedError";
  }
}

function isBlockedStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 429;
}

function createHttpError(
  message: string,
  status: number,
): Error {
  if (isBlockedStatus(status)) {
    return new GoogleNewsAccessBlockedError(
      `${message} (HTTP ${status})`,
    );
  }

  return new Error(`${message} (HTTP ${status})`);
}

function isGoogleConsentUrl(url: URL): boolean {
  return url.hostname === "consent.google.com";
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(parseInt(decimal, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(xml: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = xml.match(
    new RegExp(
      `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}\\s*>`,
      "i",
    ),
  );

  return match ? decodeXml(match[1]) : "";
}

/**
 * Convert Google News RSS XML into the result shape
 * expected by the source discovery engine.
 */
export function parseGoogleNewsRss(
  xml: string,
  query: ResearchQuery,
  maxResults = 10,
): unknown[] {
  void query;

  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new Error("maxResults must be an integer between 1 and 50");
  }

  const items = xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi);
  const results: GoogleNewsArticle[] = [];

  for (const match of items) {
    if (results.length >= maxResults) {
      break;
    }

    const item = match[1];

    const title = extractTag(item, "title");
    const link = extractTag(item, "link");
    const sourceName = extractTag(item, "source");
    const snippet = extractTag(item, "description");
    const rawDate = extractTag(item, "pubDate");

    if (!title || !link || !sourceName) {
      continue;
    }

    let publishedAt: string | undefined;

    if (rawDate) {
      const timestamp = Date.parse(rawDate);

      if (Number.isFinite(timestamp)) {
        publishedAt = new Date(timestamp).toISOString();
      }
    }

    results.push({
      title,
      url: link,
      sourceName,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }

  return results;
}

function extractAttribute(
  html: string,
  attribute: string,
): string | undefined {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = html.match(
    new RegExp(`${escaped}=["']([^"']+)["']`, "i"),
  );

  return match?.[1];
}

function extractDecodeParams(
  articleUrl: string,
  html: string,
): GoogleNewsDecodeParams {
  const url = new URL(articleUrl);

  const articleIdFromUrl = url.pathname.match(
    /\/(?:rss\/)?articles\/([^/]+)/,
  )?.[1];

  const articleId =
    extractAttribute(html, "data-n-a-id") ?? articleIdFromUrl;

  const timestamp = extractAttribute(html, "data-n-a-ts");
  const signature = extractAttribute(html, "data-n-a-sg");

  if (!articleId || !timestamp || !signature) {
    throw new Error(
      "Google News article page did not contain the required decoding parameters",
    );
  }

  if (!/^\d+$/.test(timestamp)) {
    throw new Error("Google News returned an invalid article timestamp");
  }

  return {
    articleId,
    timestamp,
    signature,
  };
}

function buildDecodeRequest(
  params: GoogleNewsDecodeParams,
): string {
  const requestPayload = [
    "garturlreq",
    [
      [
        "en-NG",
        "NG",
        ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"],
        null,
        null,
        1,
        1,
        "NG:en",
        null,
        1,
        null,
        null,
        null,
        null,
        null,
        0,
        1,
      ],
      "en-NG",
      "NG",
      1,
      [2, 3, 4, 8],
      1,
      0,
      "655000234",
      0,
      0,
      null,
      0,
    ],
    params.articleId,
    Number(params.timestamp),
    params.signature,
  ];

  const rpcRequest = [
    "Fbv4je",
    JSON.stringify(requestPayload),
    null,
    "generic",
  ];

  return new URLSearchParams({
    "f.req": JSON.stringify([[rpcRequest]]),
  }).toString();
}

function parseDecodeResponse(body: string): string {
  // Google prefixes its response with an anti-XSSI guard.
  const separator = body.indexOf("\n\n");
  const jsonBody =
    separator >= 0 ? body.slice(separator + 2) : body;

  const jsonStart = jsonBody.indexOf("[");

  if (jsonStart < 0) {
    throw new Error("Google News returned an invalid decoding response");
  }

  let frames: unknown;

  try {
    frames = JSON.parse(jsonBody.slice(jsonStart));
  } catch {
    throw new Error("Could not parse Google News decoding response");
  }

  if (!Array.isArray(frames)) {
    throw new Error("Google News decoding response has an invalid structure");
  }

  const dataFrame = frames.find(
    (frame: unknown) =>
      Array.isArray(frame) &&
      frame[0] === "wrb.fr" &&
      frame[1] === "Fbv4je",
  );

  if (!Array.isArray(dataFrame) || typeof dataFrame[2] !== "string") {
    throw new Error("Google News did not return a publisher URL");
  }

  let decodedPayload: unknown;

  try {
    decodedPayload = JSON.parse(dataFrame[2]);
  } catch {
    throw new Error("Could not parse the decoded Google News article");
  }

  if (
    !Array.isArray(decodedPayload) ||
    decodedPayload[0] !== "garturlres" ||
    typeof decodedPayload[1] !== "string"
  ) {
    throw new Error("Google News returned an invalid publisher URL");
  }

  let publisherUrl: URL;

  try {
    publisherUrl = new URL(decodedPayload[1]);
  } catch {
    throw new Error("Google News returned a malformed publisher URL");
  }

  if (
    publisherUrl.protocol !== "https:" ||
    publisherUrl.username ||
    publisherUrl.password ||
    publisherUrl.hostname === "news.google.com" ||
    isGoogleConsentUrl(publisherUrl)
  ) {
    throw new Error("Google News did not resolve to a valid publisher URL");
  }

  return publisherUrl.toString();
}

/**
 * Resolve a Google News RSS article link into its original
 * publisher URL.
 *
 * This uses Google's undocumented batchexecute endpoint.
 * It may change or be rate-limited.
 */
export async function resolveGoogleNewsArticleUrl(
  articleUrl: string,
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }

  const inputUrl = new URL(articleUrl);

  if (
    inputUrl.protocol !== "https:" ||
    inputUrl.hostname !== "news.google.com" ||
    !inputUrl.pathname.includes("/articles/")
  ) {
    throw new Error("Expected a Google News RSS article URL");
  }

  const signal = AbortSignal.timeout(timeoutMs);

  const articleResponse = await fetcher(articleUrl, {
    redirect: "follow",
    signal,
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0 DelphiEvidenceResearchAgent/1.0",
    },
  });

  const finalUrl = new URL(articleResponse.url || articleUrl);

  if (isGoogleConsentUrl(finalUrl)) {
    throw new GoogleNewsAccessBlockedError(
      "Google News redirected the article request to its consent page",
    );
  }

  if (!articleResponse.ok) {
    throw createHttpError(
      "Google News article page returned",
      articleResponse.status,
    );
  }

  // Some Google News links redirect directly to a publisher.
  if (finalUrl.hostname !== "news.google.com") {
    if (
      finalUrl.protocol !== "https:" ||
      finalUrl.username ||
      finalUrl.password
    ) {
      throw new Error("Google News redirected to an invalid destination");
    }

    return finalUrl.toString();
  }

  const html = await articleResponse.text();

  const params = extractDecodeParams(articleUrl, html);
  const requestBody = buildDecodeRequest(params);

  const decodeUrl = new URL(
    "https://news.google.com/_/DotsSplashUi/data/batchexecute",
  );

  decodeUrl.searchParams.set("rpcids", "Fbv4je");

  const decodeResponse = await fetcher(decodeUrl, {
    method: "POST",
    redirect: "follow",
    signal,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Referer: "https://news.google.com/",
      "User-Agent": "Mozilla/5.0 DelphiEvidenceResearchAgent/1.0",
    },
    body: requestBody,
  });

  const decodeFinalUrl = new URL(
    decodeResponse.url || decodeUrl.toString(),
  );

  if (isGoogleConsentUrl(decodeFinalUrl)) {
    throw new GoogleNewsAccessBlockedError(
      "Google News redirected URL decoding to its consent page",
    );
  }

  if (!decodeResponse.ok) {
    throw createHttpError(
      "Google News URL resolution returned",
      decodeResponse.status,
    );
  }

  const responseBody = await decodeResponse.text();

  return parseDecodeResponse(responseBody);
}

/**
 * Create a Google News RSS search provider.
 *
 * No API key is required. Network access is required when invoked.
 *
 * Article resolution is sequential to avoid launching a burst of
 * requests. Unresolved Google News wrapper URLs are never returned.
 * If Google blocks resolution, remaining articles are skipped.
 */
export function createGoogleNewsRssProvider(
  options: GoogleNewsRssOptions = {},
): ResearchSearchProvider {
  const fetcher = options.fetch ?? fetch;
  const maxResults = options.maxResults ?? 10;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const edition = options.edition ?? { hl: "en-NG", gl: "NG" };

  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new Error("maxResults must be an integer between 1 and 50");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }

  return async (query: ResearchQuery): Promise<unknown> => {
    const url = new URL("https://news.google.com/rss/search");

    url.searchParams.set("q", query.query);
    url.searchParams.set("hl", edition.hl);
    url.searchParams.set("gl", edition.gl);
    url.searchParams.set(
      "ceid",
      `${edition.gl}:${edition.hl.split("-")[0]}`,
    );

    const response = await fetcher(url, {
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml",
        "User-Agent": "DelphiEvidenceResearchAgent/1.0",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw createHttpError(
        "Google News RSS returned",
        response.status,
      );
    }

    const xml = await response.text();

    if (!xml.trim()) {
      throw new Error("Google News RSS returned an empty response");
    }

    const parsed = parseGoogleNewsRss(
      xml,
      query,
      maxResults,
    ) as GoogleNewsArticle[];

    const resolved: GoogleNewsArticle[] = [];

    for (const article of parsed) {
      try {
        const publisherUrl = await resolveGoogleNewsArticleUrl(
          article.url,
          {
            fetch: fetcher,
            timeoutMs,
          },
        );

        resolved.push({
          ...article,
          url: publisherUrl,
        });
      } catch (error) {
        // Google is blocking automated resolution. Do not continue
        // sending requests for the remaining articles in this query.
        if (error instanceof GoogleNewsAccessBlockedError) {
          break;
        }

        // An individual article may be unavailable or malformed.
        // Skip it, but continue trying the remaining RSS results.
        continue;
      }
    }

    return resolved;
  };
}

