import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SubmissionHistory } from "../../examples/evidence-starter/submission-history.js";
import type { Submission } from "../../src/index.js";

const entry = {
  idempotencyKey: "key-1",
  marketAddress: "0xAbC",
  marketQuestion: "Will X happen?",
  direction: "yes" as const,
  fact: "A fact.",
  asOfDate: "2026-11-20",
  sourceUrl: "https://example.com/a",
  publisher: "Example",
  note: "As of 2026-11-20: A fact.",
  links: ["https://example.com/a"],
};

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "history-")), "nested", "submissions.json");
}

describe("SubmissionHistory", () => {
  it("starts empty when the file does not exist", () => {
    expect(SubmissionHistory.load(tempPath()).all()).toEqual([]);
  });

  it("saves a new record as pending before anything is sent, and reloads it", () => {
    const path = tempPath();
    const history = SubmissionHistory.load(path, () => Date.parse("2026-11-25T00:00:00Z"));

    history.add(entry);

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    const reloaded = SubmissionHistory.load(path);

    expect(reloaded.pending()).toHaveLength(1);
    expect(reloaded.pending()[0]).toMatchObject({
      idempotencyKey: "key-1",
      status: "pending",
      attempts: 0,
      createdAt: "2026-11-25T00:00:00.000Z",
    });
  });

  it("matches market addresses case-insensitively", () => {
    const history = SubmissionHistory.inMemory();
    history.add(entry);

    expect(history.forMarket("0xabc")).toHaveLength(1);
    expect(history.forMarket("0xdef")).toHaveLength(0);
  });

  it("refuses a duplicate idempotency key", () => {
    const history = SubmissionHistory.inMemory();
    history.add(entry);

    expect(() => history.add(entry)).toThrow("Duplicate idempotency key");
  });

  it("copies the API verdict into the record", () => {
    const history = SubmissionHistory.inMemory();
    history.add(entry);

    const submission: Submission = {
      id: "sub-1",
      createdAt: "2026-11-25T00:00:00Z",
      agentId: "a",
      note: entry.note,
      links: entry.links,
      files: [],
      status: "judged",
      markets: [
        {
          marketAddress: "0xabc",
          status: "judged",
          verdict: "accepted",
          reason: "New information",
          bounty: { amount: "1.25", state: "held" },
          settlementUpTo: null,
        },
      ],
    };

    const saved = history.applySubmission("key-1", submission);

    expect(saved).toMatchObject({
      submissionId: "sub-1",
      status: "judged",
      verdict: "accepted",
      reason: "New information",
      bounty: { amount: "1.25", state: "held" },
    });
    expect(history.pending()).toHaveLength(0);
    expect(history.awaitingVerdict()).toHaveLength(0);
  });

  it("lists accepted-but-unjudged submissions as awaiting a verdict", () => {
    const history = SubmissionHistory.inMemory();
    history.add(entry);
    history.update("key-1", { status: "judging", submissionId: "sub-1" });

    expect(history.awaitingVerdict()).toHaveLength(1);
  });

  it("refuses to run on a damaged history file instead of overwriting it", () => {
    const path = tempPath();
    const history = SubmissionHistory.load(path);
    history.add(entry);
    writeFileSync(path, "{ not json", "utf8");

    expect(() => SubmissionHistory.load(path)).toThrow("is not valid JSON");
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("rejects an unknown file format", () => {
    const path = tempPath();
    SubmissionHistory.load(path).add(entry);
    writeFileSync(path, JSON.stringify({ version: 2, records: [] }), "utf8");

    expect(() => SubmissionHistory.load(path)).toThrow("unknown format");
  });
});
