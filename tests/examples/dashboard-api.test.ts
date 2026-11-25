import { describe, expect, it, vi } from "vitest";

import { EvidenceClient } from "../../src/index.js";

import { createDashboardApi, type DashboardDeps } from "../../examples/evidence-starter/dashboard-api.js";
import { ReviewQueue, candidateId } from "../../examples/evidence-starter/review-queue.js";
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
  rationale: "Approval is the resolution condition.",
  confidence: 0.85,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeDelphi(submitStatus = 202, submitBody?: unknown) {
  const submissions: string[] = [];

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";

    if (path === "/terms") return json({ version: "v1", url: "https://t.example", acceptedAt: "2026-11-25T00:00:00Z" });
    if (path === "/limits") return json({ submitsLeftThisHour: 5, hourEndsAt: "", dailyCapLeft: 5, dailyCapResetAt: "" });
    if (path.endsWith("/entry-state")) return json({ canSubmit: true, remainingOnMarket: 3, judgementPotRemainingBaseUnits: "1", rateLimit: { resetAt: "" } });
    if (path === "/submissions" && method === "GET") return json({ items: [], nextCursor: null });

    const sub = (status: string) => ({
      id: "sub-1",
      createdAt: "",
      agentId: "a",
      note: "n",
      links: [],
      files: [],
      status,
      markets: [{ marketAddress: "0xabc", status, verdict: "accepted", reason: "New", bounty: { amount: "1.5", state: "held" }, settlementUpTo: null }],
    });

    if (path === "/submissions" && method === "POST") {
      submissions.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      return json(submitBody ?? sub("queued"), submitStatus);
    }

    if (path.startsWith("/submissions/")) return json(sub("judged"));

    throw new Error(`Unexpected ${method} ${path}`);
  });

  return {
    client: new EvidenceClient({ baseUrl: "https://delphi.example/v1", apiKey: "k", fetch: fetchMock }),
    submissions,
  };
}

function setup(overrides: Partial<DashboardDeps> = {}) {
  const history = SubmissionHistory.inMemory([], now);
  const queue = ReviewQueue.inMemory(now);
  const deps: DashboardDeps = {
    history,
    queue,
    config: { agentId: "DelphiLens", llmModel: "fake", hasApiClient: true, hasSiteUrl: true },
    runResearch: async () => [candidate],
    now,
    ...overrides,
  };

  const api = createDashboardApi(deps);
  const call = (path: string, method = "GET", headers: Record<string, string> = { "x-delphilens": "1" }) =>
    api(new Request(`http://localhost:8787${path}`, { method, headers }));

  return { api, call, history, queue };
}

async function waitForRun(call: ReturnType<typeof setup>["call"]) {
  for (let i = 0; i < 50; i++) {
    const state = await (await call("/api/run")).json();

    if (state.status !== "running") {
      return state;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Run did not finish");
}

describe("dashboard API", () => {
  it("refuses POST requests without the X-DelphiLens header", async () => {
    const { call } = setup();
    const response = await call("/api/run", "POST", {});

    expect(response.status).toBe(403);
  });

  it("runs research in the background and queues its candidates", async () => {
    const { call } = setup();

    expect((await call("/api/run", "POST")).status).toBe(202);

    const state = await waitForRun(call);
    expect(state).toMatchObject({ status: "done", candidatesAdded: 1 });

    const { items } = await (await call("/api/queue")).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: candidateId(candidate), eligible: true, blockedBy: [] });
    expect(items[0].note).toContain("As of 2026-11-20");
  });

  it("refuses a second run while one is in progress", async () => {
    let finish!: () => void;
    const { call } = setup({
      runResearch: () => new Promise((resolve) => { finish = () => resolve([]); }),
    });

    await call("/api/run", "POST");
    expect((await call("/api/run", "POST")).status).toBe(409);
    finish();
  });

  it("reports a failed run with its reason", async () => {
    const { call } = setup({ runResearch: async () => { throw new Error("markets.json returned 503"); } });

    await call("/api/run", "POST");

    expect(await waitForRun(call)).toMatchObject({ status: "failed", error: "markets.json returned 503" });
  });

  it("submits a queued candidate and records it", async () => {
    const delphi = fakeDelphi();
    const { call, queue, history } = setup({ client: delphi.client });
    queue.addCandidates([candidate]);

    const response = await call(`/api/queue/${candidateId(candidate)}/submit`, "POST");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.record).toMatchObject({ status: "judged", verdict: "accepted" });
    expect(delphi.submissions).toEqual([history.all()[0].idempotencyKey]);
    expect(queue.get(candidateId(candidate))?.state).toBe("submitted");

    const overview = await (await call("/api/overview")).json();
    expect(overview.prize).toMatchObject({ judged: 1, markets: 1, qualified: false });
    expect(overview.rewards.held).toBe(1.5);
  });

  it("keeps a candidate in the queue when Delphi refuses it", async () => {
    const delphi = fakeDelphi(400, { error: { code: "invalid_request", message: "note too long", retryable: false } });
    const { call, queue } = setup({ client: delphi.client });
    queue.addCandidates([candidate]);

    const response = await call(`/api/queue/${candidateId(candidate)}/submit`, "POST");

    expect(response.status).toBe(422);
    expect(queue.get(candidateId(candidate))?.state).toBe("waiting");
  });

  it("will not submit without a Delphi client", async () => {
    const { call, queue } = setup();
    queue.addCandidates([candidate]);

    const response = await call(`/api/queue/${candidateId(candidate)}/submit`, "POST");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("DELPHI_API_ACCESS_KEY");
  });

  it("skips a candidate", async () => {
    const { call, queue } = setup();
    queue.addCandidates([candidate]);

    await call(`/api/queue/${candidateId(candidate)}/skip`, "POST");

    expect(queue.get(candidateId(candidate))?.state).toBe("skipped");
    expect((await (await call("/api/queue")).json()).items).toHaveLength(0);
  });

  it("shows why a candidate is blocked", async () => {
    const { call, queue, history } = setup();
    history.add({
      idempotencyKey: "old",
      marketAddress: "0xabc",
      marketQuestion: "q",
      direction: "no",
      fact: "An earlier fact about a court challenge to the merger.",
      asOfDate: "2026-11-10",
      sourceUrl: "https://other.example",
      publisher: "p",
      note: "n",
      links: [],
    });
    history.update("old", { status: "judged", submissionId: "s" });
    queue.addCandidates([candidate]);

    const { items } = await (await call("/api/queue")).json();

    expect(items[0].eligible).toBe(false);
    expect(items[0].blockedBy.join(" ")).toContain("cancels out");
  });

  it("returns 404 for unknown routes", async () => {
    const { call } = setup();

    expect((await call("/api/nope")).status).toBe(404);
  });
});

describe("ReviewQueue", () => {
  it("does not queue the same candidate twice", () => {
    const queue = ReviewQueue.inMemory(now);

    expect(queue.addCandidates([candidate, { ...candidate }])).toBe(1);
    expect(queue.addCandidates([candidate])).toBe(0);
  });
});

describe("run and settings endpoints", () => {
  const runRecord = {
    id: "2026-11-25T15-40-00-000Z",
    kind: "live-check",
    mode: "dry-run",
    startedAt: "2026-11-25T15:31:28Z",
    finishedAt: "2026-11-25T15:40:00Z",
    llm: { model: "openai/gpt-oss-120b", calls: 3 },
    searchProviders: ["Google News"],
    markets: [],
    findings: [{ id: "f1" }],
    submissions: null,
    metrics: { candidates: 1 },
    warnings: ["w"],
  } as unknown as import("../../examples/evidence-starter/run-record.js").RunRecord;

  it("lists runs without their findings, serves one run in full, and shows the latest in the overview", async () => {
    const { call } = setup({ loadRuns: () => [runRecord] });

    const list = await (await call("/api/runs")).json();
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).not.toHaveProperty("findings");
    expect(list.runs[0].metrics).toEqual({ candidates: 1 });

    const full = await (await call(`/api/runs/${runRecord.id}`)).json();
    expect(full.findings).toEqual([{ id: "f1" }]);

    expect((await call("/api/runs/unknown-id")).status).toBe(404);

    const overview = await (await call("/api/overview")).json();
    expect(overview.latestRun).toMatchObject({ id: runRecord.id, warnings: ["w"] });
  });

  it("returns the settings it was given and nothing else", async () => {
    const settings = { llm: { model: "openai/gpt-oss-120b", apiKey: "set" } };
    const { call } = setup({ settings });

    expect(await (await call("/api/settings")).json()).toEqual(settings);
  });
});
