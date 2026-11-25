/**
 * Separates the date an event occurred from the date a source
 * was published or discovered.
 *
 * Publication metadata is never used as a fallback evidence date.
 */

export interface EvidenceDateBounds {
  /** When the source itself was published. */
  publishedAt?: string;
  /** When this research run discovered the source. */
  discoveredAt?: string;
  /** Market deadline for admissible evidence. */
  evidenceCutoffAt?: string;
  /** Reference clock for the research run, in epoch milliseconds. */
  now?: number;
}

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const MONTH_PATTERN = Object.keys(MONTH_INDEX).join("|");

const ISO_DATE =
  /\b(\d{4})-(\d{2})-(\d{2})\b/g;

const DAY_MONTH_YEAR = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\s+(\\d{4})\\b`,
  "gi",
);

const MONTH_DAY_YEAR = new RegExp(
  `\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(\\d{4})\\b`,
  "gi",
);

/**
 * Sentences that describe the article itself rather than the
 * event the article reports.
 */
const PUBLICATION_METADATA =
  /\b(this article|this story|posted on|last updated|updated on|retrieved on|accessed on|all rights reserved|copyright)\b/i;

function timestamp(value: string | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function toIsoDate(
  year: number,
  monthIndex: number,
  day: number,
): string | undefined {
  if (
    year < 1990 ||
    year > 2100 ||
    monthIndex < 0 ||
    monthIndex > 11 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }

  const parsed = new Date(Date.UTC(year, monthIndex, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== monthIndex ||
    parsed.getUTCDate() !== day
  ) {
    return undefined;
  }

  return parsed.toISOString();
}

function splitSentences(text: string): string[] {
  return (text.match(/[\s\S]*?(?:[.!?]+(?=\s|$)|$)/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function findDates(sentence: string): string[] {
  const dates: string[] = [];

  for (const match of sentence.matchAll(ISO_DATE)) {
    const iso = toIsoDate(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    );

    if (iso) {
      dates.push(iso);
    }
  }

  for (const match of sentence.matchAll(DAY_MONTH_YEAR)) {
    const monthIndex = MONTH_INDEX[match[2].toLowerCase()];
    const iso = toIsoDate(
      Number(match[3]),
      monthIndex,
      Number(match[1]),
    );

    if (iso) {
      dates.push(iso);
    }
  }

  for (const match of sentence.matchAll(MONTH_DAY_YEAR)) {
    const monthIndex = MONTH_INDEX[match[1].toLowerCase()];
    const iso = toIsoDate(
      Number(match[3]),
      monthIndex,
      Number(match[2]),
    );

    if (iso) {
      dates.push(iso);
    }
  }

  return dates;
}

function isWithinBounds(
  isoDate: string,
  bounds: EvidenceDateBounds,
): boolean {
  const time = Date.parse(isoDate);
  const publishedAt = timestamp(bounds.publishedAt);
  const discoveredAt = timestamp(bounds.discoveredAt);
  const cutoff = timestamp(bounds.evidenceCutoffAt);

  if (publishedAt !== undefined && time > publishedAt) {
    return false;
  }

  if (discoveredAt !== undefined && time > discoveredAt) {
    return false;
  }

  if (cutoff !== undefined && time > cutoff) {
    return false;
  }

  if (
    bounds.now !== undefined &&
    Number.isFinite(bounds.now) &&
    time > bounds.now
  ) {
    return false;
  }

  return true;
}

/**
 * Extracts the latest explicit event date from source text.
 *
 * Month-only mentions and article-metadata sentences are ignored.
 * Returns undefined when no admissible event date is present.
 */
export function extractEvidenceDate(
  text: string,
  bounds: EvidenceDateBounds = {},
): string | undefined {
  if (typeof text !== "string" || !text.trim()) {
    return undefined;
  }

  const dates: string[] = [];

  for (const sentence of splitSentences(text)) {
    if (PUBLICATION_METADATA.test(sentence)) {
      continue;
    }

    for (const isoDate of findDates(sentence)) {
      if (isWithinBounds(isoDate, bounds)) {
        dates.push(isoDate);
      }
    }
  }

  if (dates.length === 0) {
    return undefined;
  }

  dates.sort((left, right) => Date.parse(left) - Date.parse(right));

  return dates[dates.length - 1];
}

/**
 * Chooses the first valid publication timestamp.
 *
 * Earlier candidates take priority. Missing and invalid values
 * are skipped. This does not invent a publication date.
 */
export function selectPublicationDate(
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const candidate of candidates) {
    if (timestamp(candidate) !== undefined) {
      return candidate;
    }
  }

  return undefined;
}
