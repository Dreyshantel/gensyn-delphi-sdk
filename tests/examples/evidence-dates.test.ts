import { describe, expect, it } from "vitest";

import {
  extractEvidenceDate,
  selectPublicationDate,
} from "../../examples/evidence-starter/evidence-dates.js";

describe("extractEvidenceDate", () => {
  describe("date format extraction", () => {
    it("extracts an ISO date", () => {
      expect(
        extractEvidenceDate("The incident occurred on 2026-11-20."),
      ).toBe("2026-11-20T00:00:00.000Z");
    });

    it("extracts DD Month YYYY dates", () => {
      expect(
        extractEvidenceDate("The incident occurred on 20 November 2026."),
      ).toBe("2026-11-20T00:00:00.000Z");
    });

    it("extracts Month DD, YYYY dates", () => {
      expect(
        extractEvidenceDate("The incident occurred on November 20, 2026."),
      ).toBe("2026-11-20T00:00:00.000Z");
    });

    it("supports abbreviated month names", () => {
      expect(
        extractEvidenceDate("The incident occurred on 20 Nov 2026."),
      ).toBe("2026-11-20T00:00:00.000Z");
    });

    it("supports ordinal day suffixes", () => {
      expect(
        extractEvidenceDate("The incident occurred on November 20th, 2026."),
      ).toBe("2026-11-20T00:00:00.000Z");
    });

    it("returns the latest admissible date when multiple dates exist", () => {
      const text =
        "The first event occurred on 10 November 2026. " +
        "A second event occurred on 20 November 2026.";

      expect(extractEvidenceDate(text)).toBe(
        "2026-11-20T00:00:00.000Z",
      );
    });
  });

  describe("invalid and unsupported dates", () => {
    it("rejects invalid calendar dates", () => {
      expect(
        extractEvidenceDate("The event occurred on 31 February 2026."),
      ).toBeUndefined();
    });

    it("rejects invalid leap-year dates", () => {
      expect(
        extractEvidenceDate("The event occurred on 29 February 2025."),
      ).toBeUndefined();
    });

    it("rejects years outside the supported range", () => {
      expect(
        extractEvidenceDate("The event occurred on 20 November 1989."),
      ).toBeUndefined();

      expect(
        extractEvidenceDate("The event occurred on 20 November 2101."),
      ).toBeUndefined();
    });

    it("does not infer a date from month-only references", () => {
      expect(
        extractEvidenceDate("The event happened in November 2026."),
      ).toBeUndefined();
    });

    it("does not infer dates from unsupported formats", () => {
      expect(
        extractEvidenceDate("The event occurred on 11/20/2026."),
      ).toBeUndefined();
    });

    it("returns undefined for empty or invalid input", () => {
      expect(extractEvidenceDate("")).toBeUndefined();
      expect(extractEvidenceDate("   ")).toBeUndefined();
      expect(extractEvidenceDate(undefined as unknown as string)).toBeUndefined();
    });
  });

  describe("date bounds", () => {
    const eventText = "The incident occurred on 20 November 2026.";

    it("rejects dates after the publication date", () => {
      expect(
        extractEvidenceDate(eventText, {
          publishedAt: "2026-11-19T12:00:00.000Z",
        }),
      ).toBeUndefined();
    });

    it("accepts dates before the publication date", () => {
      expect(
        extractEvidenceDate(eventText, {
          publishedAt: "2026-11-21T12:00:00.000Z",
        }),
      ).toBe("2026-11-20T00:00:00.000Z");
    });

    it("rejects dates after the discovery date", () => {
      expect(
        extractEvidenceDate(eventText, {
          discoveredAt: "2026-11-19T12:00:00.000Z",
        }),
      ).toBeUndefined();
    });

    it("rejects dates after the evidence cutoff", () => {
      expect(
        extractEvidenceDate(eventText, {
          evidenceCutoffAt: "2026-11-19T12:00:00.000Z",
        }),
      ).toBeUndefined();
    });

    it("rejects dates after the research reference time", () => {
      expect(
        extractEvidenceDate(eventText, {
          now: Date.parse("2026-11-19T12:00:00.000Z"),
        }),
      ).toBeUndefined();
    });

    it("accepts dates within all supplied bounds", () => {
      expect(
        extractEvidenceDate(eventText, {
          publishedAt: "2026-11-21T12:00:00.000Z",
          discoveredAt: "2026-11-22T12:00:00.000Z",
          evidenceCutoffAt: "2026-11-23T12:00:00.000Z",
          now: Date.parse("2026-11-24T12:00:00.000Z"),
        }),
      ).toBe("2026-11-20T00:00:00.000Z");
    });
  });

  describe("publication metadata exclusion", () => {
    it("ignores dates in sentences containing publication metadata", () => {
      const text =
        "The incident occurred on 15 November 2026. " +
        "This article was last updated on 20 November 2026.";

      expect(extractEvidenceDate(text)).toBe(
        "2026-11-15T00:00:00.000Z",
      );
    });

    it("does not treat an article update date as an event date", () => {
      expect(
        extractEvidenceDate("This story was updated on 20 November 2026."),
      ).toBeUndefined();
    });

    it("does not treat copyright dates as event dates", () => {
      expect(
        extractEvidenceDate("Copyright 2026. All rights reserved."),
      ).toBeUndefined();
    });
  });
});

describe("selectPublicationDate", () => {
  it("selects the first valid publication date", () => {
    expect(
      selectPublicationDate(
        "2026-11-20T10:00:00.000Z",
        "2026-11-19T10:00:00.000Z",
      ),
    ).toBe("2026-11-20T10:00:00.000Z");
  });

  it("skips missing and invalid candidates", () => {
    expect(
      selectPublicationDate(
        undefined,
        "not-a-date",
        "2026-11-20T10:00:00.000Z",
      ),
    ).toBe("2026-11-20T10:00:00.000Z");
  });

  it("returns undefined when no valid publication date exists", () => {
    expect(
      selectPublicationDate(undefined, "", "not-a-date"),
    ).toBeUndefined();
  });

  it("does not invent a publication date when no candidate is supplied", () => {
    expect(selectPublicationDate()).toBeUndefined();
  });
});

