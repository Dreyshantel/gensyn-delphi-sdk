/**
 * HTTP API behind the DelphiLens control panel.
 *
 * Kept free of server set-up so it can be tested with plain Request
 * objects. Every route works on the same history and review queue files
 * the command-line agent uses.
 *
 *   GET  /api/overview            config, prize progress, rewards, counts
 *   GET  /api/queue               candidates with their current eligibility
 *   POST /api/queue/:id/submit    submit one candidate (re-checked live)
 *   POST /api/queue/:id/skip      drop one candidate
 *   GET  /api/history             every submission record
 *   POST /api/history/refresh     fetch verdicts for submissions being judged
 *   GET  /api/run                 state and log of the research run
 *   POST /api/run                 start a research run (always dry-run)
 *   GET  /api/terms               the evidence terms and whether they are accepted
 *   GET  /api/runs                saved runs (summaries), newest first
 *   GET  /api/runs/:id            one saved run: markets, research, findings, metrics
 *   GET  /api/settings            configuration and health (never secrets)
 *
 * Safety: POST routes need the `X-DelphiLens: 1` header. A web page on
 * another site cannot send a custom header to localhost without a CORS
 * preflight, which this API never approves, so it cannot submit for you.
 * Terms are only ever accepted through ACCEPT_TERMS, never from the panel.
 */

import type { EvidenceClient } from "../../src/index.js";

import { checkEligibility, type SubmissionCandidate } from "./submission-eligibility.js";
import type { SubmissionHistory } from "./submission-history.js";
import { composeNote, refreshVerdicts, runSubmissions } from "./submission-runner.js";
import type { ReviewQueue } from "./review-queue.js";
import type { RunRecord } from "./run-record.js";

export interface DashboardConfig {
  agentId: string;
  llmModel: string | null;
  hasApiClient: boolean;
  hasSiteUrl: boolean;
  acceptTermsVersion?: string;
}

export interface DashboardDeps {
  history: SubmissionHistory;
  queue: ReviewQueue;
  client?: EvidenceClient;
  config: DashboardConfig;
  /** Runs research in dry-run and returns the candidates it found. */
  runResearch: (log: (line: string) => void) => Promise<SubmissionCandidate[]>;
  /** Saved run records, newest first. */
  loadRuns?: () => RunRecord[];
  /** Configuration summary for the Settings view. Must not contain secrets. */
  settings?: Record<string, unknown>;
  now?: () => number;
}

export interface RunState {
  status: "idle" | "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  candidatesAdded: number;
  error: string | null;
  log: string[];
}

const MAX_LOG_LINES = 2000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const errorBody = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  json({ error: message, ...extra }, status);

function toAmount(value: string | undefined): number {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

export function createDashboardApi(deps: DashboardDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;

  const run: RunState = {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    candidatesAdded: 0,
    error: null,
    log: [],
  };

  let submitting = false;

  const appendLog = (line: string) => {
    run.log.push(line);

    if (run.log.length > MAX_LOG_LINES) {
      run.log.splice(0, run.log.length - MAX_LOG_LINES);
    }
  };

  function overview() {
    const records = deps.history.all();
    const judged = records.filter((record) => record.status === "judged");
    const judgedMarkets = new Set(judged.map((record) => record.marketAddress.toLowerCase()));

    const rewards = { held: 0, paid: 0, voided: 0 };

    for (const record of records) {
      const state = record.bounty?.state;

      if (state === "held" || state === "paid" || state === "voided") {
        rewards[state] += toAmount(record.bounty?.amount);
      }
    }

    return {
      config: deps.config,
      prize: {
        judged: judged.length,
        judgedNeeded: 10,
        markets: judgedMarkets.size,
        marketsNeeded: 3,
        qualified: judged.length >= 10 && judgedMarkets.size >= 3,
      },
      rewards,
      counts: {
        submissions: records.length,
        pending: records.filter((record) => record.status === "pending").length,
        awaitingVerdict: deps.history.awaitingVerdict().length,
        rejected: records.filter((record) => record.status === "rejected").length,
        waitingForReview: deps.queue.all().filter((item) => item.state === "waiting").length,
      },
      run: { status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt },
      latestRun: (() => {
        const latest = deps.loadRuns?.()[0];

        return latest
          ? { id: latest.id, kind: latest.kind, finishedAt: latest.finishedAt, metrics: latest.metrics, warnings: latest.warnings }
          : null;
      })(),
    };
  }

  function queueView() {
    return deps.queue
      .all()
      .filter((item) => item.state === "waiting")
      .map((item) => {
        const eligibility = checkEligibility(item.candidate, {
          now: now(),
          history: deps.history.forMarket(item.candidate.marketAddress),
          accountNotes: [],
        });

        return {
          id: item.id,
          addedAt: item.addedAt,
          candidate: item.candidate,
          note: composeNote(item.candidate),
          eligible: eligibility.eligible,
          blockedBy: eligibility.reasons,
        };
      })
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.candidate.confidence - a.candidate.confidence);
  }

  function startRun(): Response {
    if (run.status === "running") {
      return errorBody("A research run is already in progress.", 409);
    }

    if (!deps.config.hasSiteUrl) {
      return errorBody("Set COMPETITION_SITE_URL in .env, then restart the panel.", 400);
    }

    Object.assign(run, {
      status: "running",
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      candidatesAdded: 0,
      error: null,
      log: [],
    });

    void deps
      .runResearch(appendLog)
      .then((candidates) => {
        run.candidatesAdded = deps.queue.addCandidates(candidates);
        appendLog(`Added ${run.candidatesAdded} new candidate(s) to the review queue.`);
        run.status = "done";
      })
      .catch((error: unknown) => {
        run.error = error instanceof Error ? error.message : String(error);
        appendLog(`Run failed: ${run.error}`);
        run.status = "failed";
      })
      .finally(() => {
        run.finishedAt = new Date(now()).toISOString();
      });

    return json({ started: true }, 202);
  }

  async function submit(id: string): Promise<Response> {
    const item = deps.queue.get(id);

    if (!item || item.state !== "waiting") {
      return errorBody("This candidate is no longer waiting for review.", 404);
    }

    if (!deps.client) {
      return errorBody("Set DELPHI_API_URL and DELPHI_API_ACCESS_KEY in .env, then restart the panel.", 400);
    }

    if (submitting) {
      return errorBody("Another submission is in progress.", 409);
    }

    submitting = true;

    const log: string[] = [];
    const before = new Set(deps.history.all().map((record) => record.idempotencyKey));

    try {
      const summary = await runSubmissions({
        candidates: [item.candidate],
        history: deps.history,
        mode: "auto",
        client: deps.client,
        acceptTermsVersion: deps.config.acceptTermsVersion,
        maxSubmissionsPerRun: 1,
        log: (...args) => log.push(args.map(String).join(" ")),
        now,
      });

      const created = deps.history.all().find((record) => !before.has(record.idempotencyKey));

      if (!created) {
        return errorBody(
          summary.stoppedReason === "terms not accepted"
            ? "The evidence terms are not accepted. Read them, set ACCEPT_TERMS in .env and restart the panel."
            : "Not submitted: the candidate failed a live check.",
          409,
          { log },
        );
      }

      const record = deps.history.all().find((r) => r.idempotencyKey === created.idempotencyKey)!;
      const refused = record.status === "failed" && !record.submissionId;

      // A submit Delphi refused outright stays in the queue so it can be fixed or skipped.
      if (!refused) {
        deps.queue.setState(id, "submitted", created.idempotencyKey);
      }

      return json({ record, log }, refused ? 422 : 200);
    } catch (error) {
      return errorBody(error instanceof Error ? error.message : String(error), 502, { log });
    } finally {
      submitting = false;
    }
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method.toUpperCase();

    if (method === "POST" && request.headers.get("x-delphilens") !== "1") {
      return errorBody("Missing X-DelphiLens header.", 403);
    }

    try {
      if (method === "GET" && path === "/api/overview") {
        return json(overview());
      }

      if (method === "GET" && path === "/api/queue") {
        return json({ items: queueView() });
      }

      const queueAction = /^\/api\/queue\/([a-f0-9]{16})\/(submit|skip)$/.exec(path);

      if (method === "POST" && queueAction) {
        const [, id, action] = queueAction;

        if (action === "skip") {
          if (!deps.queue.get(id)) {
            return errorBody("No such candidate.", 404);
          }

          return json({ item: deps.queue.setState(id, "skipped") });
        }

        return await submit(id);
      }

      if (method === "GET" && path === "/api/history") {
        return json({ records: deps.history.all().reverse() });
      }

      if (method === "POST" && path === "/api/history/refresh") {
        if (!deps.client) {
          return errorBody("Set DELPHI_API_URL and DELPHI_API_ACCESS_KEY in .env, then restart the panel.", 400);
        }

        const updated = await refreshVerdicts(deps.client, deps.history, () => {});

        return json({ updated: updated.length });
      }

      if (path === "/api/run") {
        if (method === "GET") {
          return json(run);
        }

        if (method === "POST") {
          return startRun();
        }
      }

      if (method === "GET" && path === "/api/runs") {
        const runs = deps.loadRuns?.() ?? [];

        return json({
          runs: runs.map((r) => ({
            id: r.id,
            kind: r.kind,
            mode: r.mode,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            llm: r.llm,
            searchProviders: r.searchProviders,
            metrics: r.metrics,
            warnings: r.warnings,
          })),
        });
      }

      const runMatch = /^\/api\/runs\/([A-Za-z0-9-]+)$/.exec(path);

      if (method === "GET" && runMatch) {
        const record = (deps.loadRuns?.() ?? []).find((r) => r.id === runMatch[1]);

        return record ? json(record) : errorBody("No such run.", 404);
      }

      if (method === "GET" && path === "/api/settings") {
        return json(deps.settings ?? {});
      }

      if (method === "GET" && path === "/api/terms") {
        if (!deps.client) {
          return json({ available: false });
        }

        const { data } = await deps.client.getTerms();

        return json({ available: true, ...data, acceptTermsVersion: deps.config.acceptTermsVersion ?? null });
      }

      return errorBody("Not found.", 404);
    } catch (error) {
      return errorBody(error instanceof Error ? error.message : String(error), 500);
    }
  };
}
