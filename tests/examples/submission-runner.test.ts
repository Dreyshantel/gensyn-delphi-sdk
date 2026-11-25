import { describe, expect, it, vi } from "vitest";

import { EvidenceClient } from "../../src/index.js";

import {
  composeNote,
  refreshVerdicts,
  runSubmissions,
} from "../../examples/evidence-starter/submission-runner.js";
import { SubmissionHistory } from "../../examples/evidence-starter/submission-history.js";
import type { SubmissionCandidate } from "../../examples/evidence-starter/submission-eligibility.js";

const now = () => Date.parse("2026-11-25T12:00:00Z");

const candidate: SubmissionCandidate = {
  marketAddress: "0xabc",
  marketQuestion: "Will the merger be approved by 31 December 2026?",
  marketStatus: "open",
  evidenceCutoffAt: "2026-12-10T17:00:00Z",
  direction: "yes",
  fact: "The regulator approved the merger on 20 November 2026 with no conditions attached.",
  asOfDate: "2026-11-20",
  quote: "approved the merger with no conditions",
  sourceUrl: "https://regulator.example/decision",
  publisher: "Regulator",
  publishedAt: "2026-11-21T09:00:00Z",
  rationale: "Approval is the resolution condition.",
  confidence: 0.85,
};

interface FakeApiOptions {
  termsAccepted?: boolean;
  /** Called for POST /submissions; return a Response or throw. */
  onSubmit?: (key: string, call: number) => Response | Promise<Response>;
  submissionStatus?: string;
  remainingOnMarket?: number;
  pastNotes?: string[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const submission = (id: string, status: string) => ({
  id,
  createdAt: "2026-11-25T12:00:00Z",
  agentId: "test",
  note: "n",
  links: [],
  files: [],
  status,
  markets: [
    {
      marketAddress: "0xabc",
      status,
      verdict: status === "judged" ? "accepted" : null,
      reason: status === "judged" ? "Adds new information" : null,
      bounty: status === "judged" ? { amount: "2.5", state: "held" } : null,
      settlementUpTo: null,
    },
  ],
});

function fakeApi(options: FakeApiOptions = {}) {
  const submitKeys: string[] = [];
  let submitCalls = 0;

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const headers = init?.headers as Record<string, string>;

    if (path === "/terms" && method === "GET") {
      return json({
        version: "v1",
        url: "https://delphi.example/terms",
        acceptedAt: options.termsAccepted === false ? null : "2026-11-25T00:00:00Z",
      });
    }

    if (path === "/limits") {
      return json({
        submitsLeftThisHour: 10,
        hourEndsAt: "",
        dailyCapLeft: 20,
        dailyCapResetAt: "",
      });
    }

    if (path.endsWith("/entry-state")) {
      return json({
        canSubmit: true,
        remainingOnMarket: options.remainingOnMarket ?? 3,
        judgementPotRemainingBaseUnits: "1000",
        rateLimit: { resetAt: "" },
      });
    }

    if (path === "/submissions" && method === "GET") {
      return json({
        items: (options.pastNotes ?? []).map((note, i) => ({ ...submission(`old-${i}`, "judged"), note })),
        nextCursor: null,
      });
    }

    if (path === "/submissions" && method === "POST") {
      submitCalls++;
      submitKeys.push(headers["Idempotency-Key"]);

      return options.onSubmit
        ? options.onSubmit(headers["Idempotency-Key"], submitCalls)
        : json(submission("sub-1", "queued"), 202);
    }

    if (path.startsWith("/submissions/")) {
      return json(submission(path.split("/")[2], options.submissionStatus ?? "judged"));
    }

    throw new Error(`Unexpected request ${method} ${path}`);
  });

  const client = new EvidenceClient({
    baseUrl: "https://delphi.example/v1",
    apiKey: "test",
    agentId: "test-agent",
    fetch: fetchMock,
  });

  return { client, fetchMock, submitKeys, submitCount: () => submitCalls };
}

const quiet = () => {};

describe("composeNote", () => {
  it("puts the date, fact, source and verbatim quote in the note", () => {
    const note = composeNote(candidate);

    expect(note).toContain("As of 2026-11-20: The regulator approved the merger");
    expect(note).toContain('Regulator (published 2026-11-21): "approved the merger with no conditions"');
    expect(note).toContain("Relevance: Approval is the resolution condition.");
  });

  it("caps the note length", () => {
    expect(composeNote({ ...candidate, rationale: "x".repeat(5000) }).length).toBeLessThanOrEqual(1500);
  });
});

describe("runSubmissions", () => {
  it("never submits in dry-run, even with a client", async () => {
    const api = fakeApi();
    const history = SubmissionHistory.inMemory();

    const summary = await runSubmissions({
      candidates: [candidate],
      history,
      mode: "dry-run",
      client: api.client,
      log: quiet,
      now,
    });

    expect(summary.previewed).toBe(1);
    expect(api.submitCount()).toBe(0);
    expect(history.all()).toHaveLength(0);
  });

  it("previews only one side of a market within a single run", async () => {
    const summary = await runSubmissions({
      candidates: [
        candidate,
        {
          ...candidate,
          direction: "no",
          confidence: 0.7,
          fact: "Opposition lawmakers filed a challenge to the merger in court on 22 November.",
          sourceUrl: "https://news.example/challenge",
        },
      ],
      history: SubmissionHistory.inMemory(),
      mode: "dry-run",
      log: quiet,
      now,
    });

    expect(summary.previewed).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it("does not submit when the person declines in approve mode", async () => {
    const api = fakeApi();
    const confirm = vi.fn(async () => false);

    const summary = await runSubmissions({
      candidates: [candidate],
      history: SubmissionHistory.inMemory(),
      mode: "approve",
      client: api.client,
      confirm,
      log: quiet,
      now,
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(summary.declined).toBe(1);
    expect(api.submitCount()).toBe(0);
  });

  it("submits with the saved idempotency key and records the verdict", async () => {
    const api = fakeApi();
    const history = SubmissionHistory.inMemory();

    const summary = await runSubmissions({
      candidates: [candidate],
      history,
      mode: "auto",
      client: api.client,
      log: quiet,
      now,
    });

    const [record] = history.all();

    expect(summary).toMatchObject({ submitted: 1, judged: 1 });
    expect(api.submitKeys).toEqual([record.idempotencyKey]);
    expect(record).toMatchObject({
      status: "judged",
      verdict: "accepted",
      bounty: { amount: "2.5", state: "held" },
      direction: "yes",
    });
  });

  it("keeps a timed-out submit pending and resends it with the same key next run", async () => {
    const api = fakeApi({
      onSubmit: (_key, call) => {
        if (call === 1) {
          throw new TypeError("fetch failed");
        }

        return json(submission("sub-1", "queued"), 202);
      },
    });
    const history = SubmissionHistory.inMemory();

    const first = await runSubmissions({
      candidates: [candidate],
      history,
      mode: "auto",
      client: api.client,
      log: quiet,
      now,
    });

    expect(first.submitted).toBe(0);
    expect(history.pending()).toHaveLength(1);

    const second = await runSubmissions({
      candidates: [],
      history,
      mode: "auto",
      client: api.client,
      log: quiet,
      now,
    });

    expect(second.resumed).toBe(1);
    expect(api.submitKeys[0]).toBe(api.submitKeys[1]);
    expect(history.all()[0].status).toBe("judged");
  });

  it("marks a refused submit as failed without retrying it", async () => {
    const api = fakeApi({
      onSubmit: () =>
        json({ error: { code: "invalid_request", message: "note too long", retryable: false } }, 400),
    });
    const history = SubmissionHistory.inMemory();

    const summary = await runSubmissions({
      candidates: [candidate],
      history,
      mode: "auto",
      client: api.client,
      log: quiet,
      now,
    });

    expect(summary.failed).toBe(1);
    expect(history.all()[0]).toMatchObject({ status: "failed", lastError: "note too long" });
    expect(history.pending()).toHaveLength(0);
  });

  it("stops before submitting when the terms are not accepted", async () => {
    const api = fakeApi({ termsAccepted: false });

    const summary = await runSubmissions({
      candidates: [candidate],
      history: SubmissionHistory.inMemory(),
      mode: "auto",
      client: api.client,
      log: quiet,
      now,
    });

    expect(summary.stoppedReason).toBe("terms not accepted");
    expect(api.submitCount()).toBe(0);
  });

  it("skips a fact the account already submitted to the market", async () => {
    const api = fakeApi({
      pastNotes: ["As of 2026-11-20: The regulator approved the merger with no conditions attached."],
    });

    const summary = await runSubmissions({
      candidates: [candidate],
      history: SubmissionHistory.inMemory(),
      mode: "auto",
      client: api.client,
      log: quiet,
      now,
    });

    expect(summary.skipped).toBe(1);
    expect(api.submitCount()).toBe(0);
  });

  it("respects the per-run submission limit", async () => {
    const api = fakeApi();
    const others = [1, 2].map((i) => ({
      ...candidate,
      marketAddress: `0x${i}`,
      sourceUrl: `https://example.com/${i}`,
    }));

    const summary = await runSubmissions({
      candidates: [candidate, ...others],
      history: SubmissionHistory.inMemory(),
      mode: "auto",
      client: api.client,
      maxSubmissionsPerRun: 2,
      log: quiet,
      now,
    });

    expect(api.submitCount()).toBe(2);
    expect(summary.stoppedReason).toBe("per-run limit reached");
  });

  it("refuses live modes without a client", async () => {
    await expect(
      runSubmissions({
        candidates: [],
        history: SubmissionHistory.inMemory(),
        mode: "auto",
        log: quiet,
      }),
    ).rejects.toThrow('needs a Delphi API client');
  });
});

describe("refreshVerdicts", () => {
  it("records verdicts for submissions still being judged", async () => {
    const api = fakeApi({ submissionStatus: "judged" });
    const history = SubmissionHistory.inMemory();

    history.add({
      idempotencyKey: "k",
      marketAddress: "0xabc",
      marketQuestion: "q",
      direction: "yes",
      fact: "f",
      asOfDate: "2026-11-20",
      sourceUrl: "https://x.example",
      publisher: "p",
      note: "n",
      links: [],
    });
    history.update("k", { status: "judging", submissionId: "sub-9" });

    const updated = await refreshVerdicts(api.client, history, quiet);

    expect(updated).toHaveLength(1);
    expect(history.all()[0]).toMatchObject({ status: "judged", verdict: "accepted" });
  });
});

describe("orderCandidates", () => {
  it("takes every market's best candidate before any market's second", async () => {
    const { orderCandidates } = await import("../../examples/evidence-starter/submission-runner.js");
    const a1 = { ...candidate, marketAddress: "0xA", confidence: 0.95 };
    const a2 = { ...candidate, marketAddress: "0xA", confidence: 0.9 };
    const b1 = { ...candidate, marketAddress: "0xB", confidence: 0.7 };
    const c1 = { ...candidate, marketAddress: "0xC", confidence: 0.65 };

    expect(orderCandidates([a2, c1, a1, b1])).toEqual([a1, b1, c1, a2]);
  });
});

describe("corroborated notes", () => {
  it("names the confirming source in the note and sends its link second", async () => {
    const api = fakeApi();
    const history = SubmissionHistory.inMemory();
    const confirmed = {
      ...candidate,
      publisher: "Around Prague",
      credibility: "unknown" as const,
      corroboratedBy: { publisher: "Federal Reserve", credibility: "primary" as const },
      supportingLinks: ["https://www.federalreserve.gov/monetarypolicy/fomcminutes20261028.htm"],
    };

    expect(composeNote(confirmed)).toContain("Also reported by Federal Reserve (link 2).");

    await runSubmissions({ candidates: [confirmed], history, mode: "auto", client: api.client, log: quiet, now });

    expect(history.all()[0].links).toEqual([
      candidate.sourceUrl,
      "https://www.federalreserve.gov/monetarypolicy/fomcminutes20261028.htm",
    ]);
  });
});
