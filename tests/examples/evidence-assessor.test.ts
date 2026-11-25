
import { describe, expect, it, vi } from "vitest";
import {
  assessEvidence,
  type EvidenceAssessmentInput,
} from "../../examples/evidence-starter/evidence-assessor.js";

const input: EvidenceAssessmentInput = {
  marketQuestion: "Will the company announce an IPO before December 2026?",
  resolutionCriteria:
    "YES if the company publicly announces an IPO before December 1, 2026.",
  evidenceClaim:
    "The company publicly announced plans to launch an IPO.",
  sourceExcerpt:
    "The company confirmed today that it plans to launch an initial public offering before the end of November.",
  sourceUrl: "https://example.com/ipo-announcement",
  evidenceDate: "2026-11-20T10:00:00.000Z",
  evidenceCutoffAt: "2026-12-01T00:00:00.000Z",
};

const validAssessment = {
  direction: "yes",
  relevanceScore: 0.95,
  rationale:
    "The source directly reports an IPO announcement before the market deadline.",
  supportingStatements: [
    "The company confirmed plans for an IPO.",
    "The announcement occurred before the evidence cutoff.",
  ],
  limitations: [
    "The source describes plans but does not establish that the IPO has been completed.",
  ],
};

describe("evidence assessor", () => {
  describe("input validation", () => {
    it("rejects an empty market question", async () => {
      await expect(
        assessEvidence(
          { ...input, marketQuestion: " " },
          vi.fn(),
        ),
      ).rejects.toThrow("marketQuestion cannot be empty");
    });

    it("rejects an empty resolution criterion", async () => {
      await expect(
        assessEvidence(
          { ...input, resolutionCriteria: "" },
          vi.fn(),
        ),
      ).rejects.toThrow("resolutionCriteria cannot be empty");
    });

    it("rejects an invalid source URL", async () => {
      await expect(
        assessEvidence(
          { ...input, sourceUrl: "not-a-url" },
          vi.fn(),
        ),
      ).rejects.toThrow("Source URL must be a valid HTTP or HTTPS URL");
    });

    it("rejects an invalid evidence date", async () => {
      await expect(
        assessEvidence(
          { ...input, evidenceDate: "not-a-date" },
          vi.fn(),
        ),
      ).rejects.toThrow("Invalid evidenceDate");
    });

    it("accepts a publication date without an event date", async () => {
      const { evidenceDate: _evidenceDate, ...withoutEvidenceDate } =
        input;

      const model = vi.fn().mockResolvedValue(validAssessment);

      await expect(
        assessEvidence(
          {
            ...withoutEvidenceDate,
            publishedAt: "2026-11-20T10:00:00.000Z",
          },
          model,
        ),
      ).resolves.toMatchObject({
        direction: "yes",
      });
    });

    it("rejects an assessment that has neither date", async () => {
      const { evidenceDate: _evidenceDate, ...withoutEvidenceDate } =
        input;

      await expect(
        assessEvidence(withoutEvidenceDate, vi.fn()),
      ).rejects.toThrow(
        "A publication date or an evidence date is required",
      );
    });

    it("rejects a publication date after the cutoff", async () => {
      await expect(
        assessEvidence(
          {
            ...input,
            publishedAt: "2026-12-02T00:00:00.000Z",
          },
          vi.fn(),
        ),
      ).rejects.toThrow(
        "Publication date is after the market evidence cutoff",
      );
    });

    it("rejects an evidence date after the publication date", async () => {
      await expect(
        assessEvidence(
          {
            ...input,
            publishedAt: "2026-11-18T00:00:00.000Z",
            evidenceDate: "2026-11-20T10:00:00.000Z",
          },
          vi.fn(),
        ),
      ).rejects.toThrow(
        "Evidence date cannot be after the publication date",
      );
    });

    it("rejects evidence published after the cutoff", async () => {
      await expect(
        assessEvidence(
          {
            ...input,
            evidenceDate: "2026-12-02T00:00:00.000Z",
          },
          vi.fn(),
        ),
      ).rejects.toThrow(
        "Evidence date is after the market evidence cutoff",
      );
    });
  });

  describe("model response validation", () => {
    it("accepts a valid YES assessment", async () => {
      const model = vi.fn().mockResolvedValue(validAssessment);

      const result = await assessEvidence(input, model);

      expect(result.direction).toBe("yes");
      expect(result.relationship).toBe("direct_support");
      expect(result.relevanceScore).toBe(0.95);
      expect(result.supportingStatements).toHaveLength(2);
      expect(model).toHaveBeenCalledOnce();
    });

    it("accepts a valid NO assessment", async () => {
      const model = vi.fn().mockResolvedValue({
        ...validAssessment,
        direction: "no",
        relevanceScore: 0.85,
        rationale: "The source contradicts the predicted outcome.",
      });

      const result = await assessEvidence(input, model);

      expect(result.direction).toBe("no");
      expect(result.relationship).toBe("contradiction");
    });

    it("accepts an inconclusive assessment without a direction", async () => {
      const model = vi.fn().mockResolvedValue({
        ...validAssessment,
        direction: undefined,
        relationship: "inconclusive",
        relevanceScore: 0.1,
        rationale: "The source does not establish either outcome.",
      });

      const result = await assessEvidence(input, model);

      expect(result.direction).toBeUndefined();
      expect(result.relationship).toBe("inconclusive");
    });

    it("preserves an explicit contextual relationship without a direction", async () => {
      const result = await assessEvidence(
        input,
        vi.fn().mockResolvedValue({
          ...validAssessment,
          direction: undefined,
          relationship: "context",
          rationale: "The source supplies background only.",
        }),
      );

      expect(result.relationship).toBe("context");
      expect(result.direction).toBeUndefined();
    });

    it("rejects an invalid evidence relationship", async () => {
      await expect(
        assessEvidence(
          input,
          vi.fn().mockResolvedValue({
            ...validAssessment,
            relationship: "maybe",
          }),
        ),
      ).rejects.toThrow(
        "Assessment has an invalid evidence relationship",
      );
    });

    it("rejects a non-object model response", async () => {
      await expect(
        assessEvidence(input, vi.fn().mockResolvedValue(null)),
      ).rejects.toThrow("Assessment response must be an object");
    });

    it("rejects an invalid direction", async () => {
      await expect(
        assessEvidence(
          input,
          vi.fn().mockResolvedValue({
            ...validAssessment,
            direction: "maybe",
          }),
        ),
      ).rejects.toThrow("Assessment has an invalid evidence direction");
    });

    it("rejects a relevance score outside the valid range", async () => {
      await expect(
        assessEvidence(
          input,
          vi.fn().mockResolvedValue({
            ...validAssessment,
            relevanceScore: 1.5,
          }),
        ),
      ).rejects.toThrow("Relevance score must be between 0 and 1");
    });

    it("rejects an empty rationale", async () => {
      await expect(
        assessEvidence(
          input,
          vi.fn().mockResolvedValue({
            ...validAssessment,
            rationale: " ",
          }),
        ),
      ).rejects.toThrow("Assessment rationale cannot be empty");
    });

    it("rejects invalid supporting statements", async () => {
      await expect(
        assessEvidence(
          input,
          vi.fn().mockResolvedValue({
            ...validAssessment,
            supportingStatements: ["", 123],
          }),
        ),
      ).rejects.toThrow(
        "Supporting statements must be non-empty strings",
      );
    });

    it("rejects invalid limitations", async () => {
      await expect(
        assessEvidence(
          input,
          vi.fn().mockResolvedValue({
            ...validAssessment,
            limitations: ["", null],
          }),
        ),
      ).rejects.toThrow(
        "Limitations must be non-empty strings",
      );
    });
  });

  describe("model execution", () => {
    it("propagates model errors", async () => {
      const model = vi.fn().mockRejectedValue(
        new Error("Model service unavailable"),
      );

      await expect(
        assessEvidence(input, model),
      ).rejects.toThrow("Model service unavailable");
    });
  });
});

