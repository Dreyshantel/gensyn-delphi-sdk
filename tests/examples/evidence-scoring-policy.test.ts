
import { describe, expect, it } from "vitest";

import {
  createEvidenceScoringPolicy,
  DEFAULT_SOURCE_CREDIBILITY,
  DEFAULT_VERIFIABILITY_SCORE,
} from "../../examples/evidence-starter/evidence-scoring-policy.js";

describe("evidence scoring policy", () => {
  it("provides conservative default credibility scores", () => {
    const policy = createEvidenceScoringPolicy();

    expect(policy.credibility).toEqual(
      DEFAULT_SOURCE_CREDIBILITY,
    );

    expect(policy.getCredibility("regulatory")).toBe(0.95);
    expect(policy.getCredibility("other")).toBe(0.35);
  });

  it("classifies explicitly configured domains", () => {
    const policy = createEvidenceScoringPolicy({
      sourceTypesByDomain: {
        "cbn.gov.ng": "regulatory",
        "reuters.com": "news",
        "university.edu": "academic",
      },
    });

    expect(
      policy.classifySource(
        "https://www.cbn.gov.ng/news/article",
      ),
    ).toBe("regulatory");

    expect(
      policy.classifySource(
        "https://reuters.com/article",
      ),
    ).toBe("news");

    expect(
      policy.classifySource(
        "https://university.edu/research",
      ),
    ).toBe("academic");
  });

  it("classifies unknown domains as other", () => {
    const policy = createEvidenceScoringPolicy();

    expect(
      policy.classifySource(
        "https://unknown-example.com/article",
      ),
    ).toBe("other");
  });

  it("does not trust an unconfigured subdomain", () => {
    const policy = createEvidenceScoringPolicy({
      sourceTypesByDomain: {
        "cbn.gov.ng": "regulatory",
      },
    });

    expect(
      policy.classifySource(
        "https://fake.cbn.gov.ng.example.com/article",
      ),
    ).toBe("other");
  });

  it("supports credibility overrides", () => {
    const policy = createEvidenceScoringPolicy({
      credibility: {
        news: 0.75,
      },
    });

    expect(policy.getCredibility("news")).toBe(0.75);
    expect(policy.getCredibility("official")).toBe(0.90);
  });

  it("uses conservative default verifiability", () => {
    const policy = createEvidenceScoringPolicy();

    expect(
      policy.getVerifiability(
        "https://unknown-example.com/article",
      ),
    ).toBe(DEFAULT_VERIFIABILITY_SCORE);
  });

  it("supports explicit verifiability overrides", () => {
    const policy = createEvidenceScoringPolicy({
      verifiabilityByUrl: {
        "https://example.com/official-report": 0.95,
      },
    });

    expect(
      policy.getVerifiability(
        "https://example.com/official-report",
      ),
    ).toBe(0.95);
  });

  it("ignores URL fragments when matching overrides", () => {
    const policy = createEvidenceScoringPolicy({
      verifiabilityByUrl: {
        "https://example.com/report": 0.90,
      },
    });

    expect(
      policy.getVerifiability(
        "https://example.com/report#section-two",
      ),
    ).toBe(0.90);
  });

  it("rejects invalid credibility scores", () => {
    expect(() =>
      createEvidenceScoringPolicy({
        credibility: {
          news: 1.5,
        },
      }),
    ).toThrow(/between 0 and 1/i);
  });

  it("rejects invalid verifiability scores", () => {
    expect(() =>
      createEvidenceScoringPolicy({
        verifiabilityByUrl: {
          "https://example.com/report": -0.1,
        },
      }),
    ).toThrow(/between 0 and 1/i);
  });

  it("rejects invalid default verifiability", () => {
    expect(() =>
      createEvidenceScoringPolicy({
        defaultVerifiability: 2,
      }),
    ).toThrow(/between 0 and 1/i);
  });
});

