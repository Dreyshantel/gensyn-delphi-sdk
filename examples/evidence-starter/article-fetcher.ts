
import { isIP } from "node:net";
import { load } from "cheerio";
import { fetch as undiciFetch } from "undici";

import {
  createSecureAgent,
  isPublicIpAddress,
} from "./secure-fetch.js";

export interface ArticleFetchResult {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  content: string;
  contentType: string;
  fetchedAt: string;
  publishedAt?: string;
  publicationDateSource?: string;
}

export interface ArticleFetcherOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const UNWANTED_TAGS = [
  "script", "style", "noscript", "svg", "nav", "footer",
  "header", "aside", "form", "iframe", "object", "template",
  "head", "dialog", "button",
].join(", ");

const UNWANTED_CLASS_OR_ID =
  /(?:^|[\s_-])(?:advert(?:isement)?|ads?|cookie|consent|sidebar|related|recommend(?:ed|ation)?|breadcrumb|social|share|newsletter|promo(?:tion)?|modal|popup|menu|navigation|comments?|outbrain|taboola)(?:$|[\s_-])/i;

const RELATED_CONTENT_PREFIX =
  /^(?:also read|read more|related(?:\s+(?:story|stories|article|articles))?|continue reading)\b/i;

const BOILERPLATE_ONLY =
  /^(?:(?:home|menu|search|sign in|log in|subscribe|newsletter|share|follow us|read more|next|previous|contact us|privacy policy|terms(?: of service)?|advertisement)\s*[|•·-]?\s*)+$/i;

const CANDIDATE_SELECTORS: Array<{
  selector: string;
  priority: number;
}> = [
  { selector: '[itemprop="articleBody"]', priority: 7 },
  { selector: '[class*="article-body"]', priority: 6 },
  { selector: '[id*="article-body"]', priority: 6 },
  { selector: '[class*="article-content"]', priority: 6 },
  { selector: '[id*="article-content"]', priority: 6 },
  { selector: '[class*="article_content"]', priority: 6 },
  { selector: '[class*="story-body"]', priority: 6 },
  { selector: '[class*="entry-content"]', priority: 6 },
  { selector: '[class*="post-content"]', priority: 6 },
  { selector: "article", priority: 5 },
  { selector: "main", priority: 4 },
  { selector: '[role="main"]', priority: 3 },
  { selector: "body", priority: 1 },
];

/**
 * Reject non-HTTPS URLs, local hostnames, and non-public IP addresses.
 *
 * Literal IP addresses are checked directly because they do not require
 * DNS resolution. Hostnames are additionally checked at connection time
 * by the secure Undici DNS lookup.
 */
function validatePublicUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid article URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS article URLs are allowed");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".example") ||
    host.endsWith(".invalid") ||
    host.endsWith(".home.arpa")
  ) {
    throw new Error("Local and internal hosts are not allowed");
  }

  const ipVersion = isIP(host);

  if (ipVersion !== 0 && !isPublicIpAddress(host)) {
    throw new Error("Private or non-public IP addresses are not allowed");
  }

  return url;
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string {
  const $ = load(html);

  const title =
    $("title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $('meta[name="twitter:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    "";

  return normalizeText(title).replace(/\s+/g, " ");
}

/* -------------------------------------------------------------------------- */
/* Publication-date extraction                                                */
/* -------------------------------------------------------------------------- */

interface ExtractedPublicationDate {
  publishedAt?: string;
  publicationDateSource?: string;
}

function normalisePublicationDate(
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const timestamp = Date.parse(value.trim());

  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  return new Date(timestamp).toISOString();
}

function findJsonLdPublicationDate(
  value: unknown,
  depth = 0,
): string | undefined {
  if (depth > 12) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findJsonLdPublicationDate(item, depth + 1);

      if (result) {
        return result;
      }
    }

    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  const directDate = normalisePublicationDate(record.datePublished);

  if (directDate) {
    return directDate;
  }

  for (const nestedValue of Object.values(record)) {
    const result = findJsonLdPublicationDate(
      nestedValue,
      depth + 1,
    );

    if (result) {
      return result;
    }
  }

  return undefined;
}

function extractPublicationDate(
  html: string,
): ExtractedPublicationDate {
  const $ = load(html);

  const jsonLdScripts = $('script[type="application/ld+json"]').toArray();

  for (const script of jsonLdScripts) {
    const rawJson = $(script).text().trim();

    if (!rawJson) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(rawJson);
      const publishedAt = findJsonLdPublicationDate(parsed);

      if (publishedAt) {
        return {
          publishedAt,
          publicationDateSource: "json-ld:datePublished",
        };
      }
    } catch {
      // Malformed JSON-LD should not prevent other metadata checks.
    }
  }

  const metadataCandidates = [
    {
      selector: 'meta[property="article:published_time"]',
      source: "meta:article:published_time",
    },
    {
      selector: 'meta[property="og:published_time"]',
      source: "meta:og:published_time",
    },
    {
      selector: 'meta[name="article:published_time"]',
      source: "meta:name:article:published_time",
    },
    {
      selector: 'meta[name="datePublished"]',
      source: "meta:name:datePublished",
    },
    {
      selector: 'meta[itemprop="datePublished"]',
      source: "meta:itemprop:datePublished",
    },
    {
      selector: 'meta[name="pubdate"]',
      source: "meta:name:pubdate",
    },
    {
      selector: 'meta[name="publishdate"]',
      source: "meta:name:publishdate",
    },
    {
      selector: 'meta[name="publication_date"]',
      source: "meta:name:publication_date",
    },
  ];

  for (const candidate of metadataCandidates) {
    const rawDate = $(candidate.selector)
      .first()
      .attr("content");

    const publishedAt = normalisePublicationDate(rawDate);

    if (publishedAt) {
      return {
        publishedAt,
        publicationDateSource: candidate.source,
      };
    }
  }

  const timeCandidates = [
    "time[itemprop='datePublished']",
    "time[pubdate]",
    "[itemprop='datePublished']",
  ];

  for (const selector of timeCandidates) {
    const element = $(selector).first();

    const rawDate =
      element.attr("datetime") ??
      element.attr("content") ??
      element.text().trim();

    const publishedAt = normalisePublicationDate(rawDate);

    if (publishedAt) {
      return {
        publishedAt,
        publicationDateSource: `html:${selector}`,
      };
    }
  }

  return {};
}

/* -------------------------------------------------------------------------- */
/* Article content extraction                                                 */
/* -------------------------------------------------------------------------- */

function removeInlineRelatedContent(
  $: ReturnType<typeof load>,
): void {
  $("p, li, div, span").each((_index, element) => {
    const node = $(element);
    const text = node.text().replace(/\s+/g, " ").trim();

    if (
      text.length > 0 &&
      text.length <= 500 &&
      RELATED_CONTENT_PREFIX.test(text) &&
      node.find("a").length > 0
    ) {
      node.remove();
    }
  });

  $("a").each((_index, element) => {
    const link = $(element);
    const text = link.text().replace(/\s+/g, " ").trim();

    if (RELATED_CONTENT_PREFIX.test(text)) {
      const parent = link.parent();

      link.remove();

      const remainingText = parent.text().replace(/\s+/g, " ").trim();

      if (
        !remainingText ||
        (remainingText.length <= 100 &&
          RELATED_CONTENT_PREFIX.test(remainingText))
      ) {
        parent.remove();
      }
    }
  });
}

function cleanDocument($: ReturnType<typeof load>): void {
  $(UNWANTED_TAGS).remove();

  $(
    [
      "[hidden]",
      '[aria-hidden="true"]',
      '[role="navigation"]',
      '[role="complementary"]',
      '[role="contentinfo"]',
      '[role="banner"]',
      '[role="search"]',
    ].join(", "),
  ).remove();

  $("[class], [id], [aria-label]").each((_index, element) => {
    const node = $(element);

    const identity = [
      node.attr("class"),
      node.attr("id"),
      node.attr("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");

    if (UNWANTED_CLASS_OR_ID.test(identity)) {
      node.remove();
    }
  });

  removeInlineRelatedContent($);
}

function htmlToReadableText(html: string): string {
  const $ = load(`<div id="article-extraction-root">${html}</div>`);
  const root = $("#article-extraction-root");

  const blockSelector =
    "h1, h2, h3, h4, h5, h6, p, blockquote, li, pre, td";

  const blocks = root.find(blockSelector).toArray();
  const lines: string[] = [];

  for (const block of blocks) {
    const node = $(block);

    if (node.parents(blockSelector).length > 0) {
      continue;
    }

    const text = normalizeText(node.text())
      .replace(RELATED_CONTENT_PREFIX, "")
      .trim();

    if (text) {
      lines.push(text);
    }
  }

  if (lines.length > 0) {
    return Array.from(new Set(lines)).join("\n\n");
  }

  return normalizeText(root.text());
}

interface ContentCandidate {
  text: string;
  priority: number;
  wordCount: number;
  paragraphCount: number;
}

function scoreCandidate(
  text: string,
  priority: number,
): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const paragraphCount = text.split(/\n{2,}/).filter(Boolean).length;
  const sentenceCount = text.split(/[.!?]+/).filter(Boolean).length;

  return (
    priority * 1000 +
    Math.min(wordCount, 2000) +
    Math.min(paragraphCount, 30) * 25 +
    Math.min(sentenceCount, 40) * 5
  );
}

function extractText(html: string): string {
  const $ = load(html);

  cleanDocument($);

  const candidates: ContentCandidate[] = [];
  const seen = new WeakSet<object>();

  for (const candidate of CANDIDATE_SELECTORS) {
    $(candidate.selector).each((_index, element) => {
      if (seen.has(element)) {
        return;
      }

      seen.add(element);

      const candidateHtml = $(element).html() ?? "";
      const text = htmlToReadableText(candidateHtml);

      if (!text) {
        return;
      }

      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const paragraphCount = text
        .split(/\n{2,}/)
        .filter(Boolean).length;

      candidates.push({
        text,
        priority: candidate.priority,
        wordCount,
        paragraphCount,
      });
    });
  }

  if (candidates.length === 0) {
    return "";
  }

  candidates.sort(
    (a, b) =>
      scoreCandidate(b.text, b.priority) -
      scoreCandidate(a.text, a.priority),
  );

  return candidates[0].text;
}

function validateExtractedContent(
  content: string,
  contentType: string,
): void {
  if (!content.trim()) {
    throw new Error("No readable article content was extracted");
  }

  if (
    contentType !== "text/plain" &&
    BOILERPLATE_ONLY.test(content.replace(/\s+/g, " ").trim())
  ) {
    throw new Error(
      "Extracted content appears to contain page navigation or boilerplate rather than an article",
    );
  }
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    throw new Error("Article response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let totalBytes = 0;
  let output = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the size-limit error.
        }

        throw new Error("Article response exceeds the size limit");
      }

      output += decoder.decode(value, { stream: true });
    }

    output += decoder.decode();

    return output;
  } finally {
    reader.releaseLock();
  }
}

/* -------------------------------------------------------------------------- */
/* Secure article fetching                                                    */
/* -------------------------------------------------------------------------- */

export async function fetchArticle(
  articleUrl: string,
  options: ArticleFetcherOptions = {},
): Promise<ArticleFetchResult> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxBytes = options.maxBytes ?? 1_500_000;
  const maxRedirects = options.maxRedirects ?? 5;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }

  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer");
  }

  if (
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 10
  ) {
    throw new Error("maxRedirects must be between 0 and 10");
  }

  const requestedUrl = validatePublicUrl(articleUrl).toString();
  let currentUrl = requestedUrl;

  const controller = new AbortController();

  const secureAgent = options.fetch
    ? undefined
    : createSecureAgent();

  const fetcher: typeof fetch =
    options.fetch ??
    ((input, init) => {
      return undiciFetch(input, {
        ...init,
        dispatcher: secureAgent!,
      }) as unknown as Promise<Response>;
    });

  let response: Response | undefined;

  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );

  try {
    for (
      let redirects = 0;
      redirects <= maxRedirects;
      redirects++
    ) {
      validatePublicUrl(currentUrl);

      response = await fetcher(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html, text/plain;q=0.9",
          "User-Agent": "DelphiEvidenceResearchAgent/1.0",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");

        if (!location) {
          throw new Error(
            "Redirect response has no Location header",
          );
        }

        if (redirects === maxRedirects) {
          throw new Error("Maximum redirect count exceeded");
        }

        try {
          await response.body?.cancel();
        } catch {
          // Redirect validation takes priority over body cleanup.
        }

        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      break;
    }

    if (!response || !response.ok) {
      throw new Error(
        `Article fetch failed with HTTP ${response?.status ?? "unknown"}`,
      );
    }

    const contentType =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() ?? "";

    if (
      contentType !== "text/html" &&
      contentType !== "text/plain" &&
      contentType !== "application/xhtml+xml"
    ) {
      throw new Error(
        `Unsupported article content type: ${contentType || "unknown"}`,
      );
    }

    const declaredLengthHeader =
      response.headers.get("content-length");

    const declaredLength = declaredLengthHeader
      ? Number(declaredLengthHeader)
      : 0;

    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maxBytes
    ) {
      throw new Error("Article response exceeds the size limit");
    }

    const body = await readLimitedBody(response, maxBytes);

    const title =
      contentType === "text/plain"
        ? ""
        : extractTitle(body);

    const content =
      contentType === "text/plain"
        ? body.trim()
        : extractText(body);

    validateExtractedContent(content, contentType);

    const publicationMetadata =
      contentType === "text/plain"
        ? {}
        : extractPublicationDate(body);

    return {
      requestedUrl,
      finalUrl: currentUrl,
      title,
      contentType,
      content,
      fetchedAt: new Date().toISOString(),
      ...publicationMetadata,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Article fetch timed out", {
        cause: error,
      });
    }

    throw error;
  } finally {
    clearTimeout(timeout);

    if (response?.body && !response.bodyUsed) {
      try {
        await response.body.cancel();
      } catch {
        // Do not mask the original fetch result or error.
      }
    }

    if (secureAgent) {
      try {
        await secureAgent.close();
      } catch {
        try {
          await secureAgent.destroy();
        } catch {
          // Do not mask the original fetch result or error.
        }
      }
    }
  }
}

