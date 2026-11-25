/**
 * Safe evidence submission.
 *
 * Modes:
 *   - "dry-run" (default): prints exactly what would be sent. Never submits.
 *     Uses read-only API calls (limits, entry state, past submissions)
 *     when a client is available, so the preview matches a live run.
 *   - "approve": asks a person (y/n) before every submission.
 *   - "auto": submits every eligible candidate, within `maxSubmissionsPerRun`.
 *
 * Safety properties:
 *   - The idempotency key is saved to history BEFORE the submit call, so a
 *     timed-out submit is resent with the same key on the next run and
 *     cannot use a second slot.
 *   - Terms are never accepted unless the exact version is supplied.
 *   - All of a market's submissions point the same way.
 */

import { randomUUID } from "node:crypto";

import {
  EvidenceApiError,
  TermsNotAcceptedError,
  type EvidenceClient,
  type EvidenceLimits,
  type EntryState,
} from "../../src/index.js";

import {
  checkEligibility,
  type SubmissionCandidate,
} from "./submission-eligibility.js";

import type {
  SubmissionHistory,
  SubmissionRecord,
} from "./submission-history.js";

export type SubmissionMode = "dry-run" | "approve" | "auto";

export interface SubmissionRunOptions {
  candidates: SubmissionCandidate[];
  history: SubmissionHistory;
  mode: SubmissionMode;
  /** Required for "approve" and "auto". Optional for "dry-run" (read-only use). */
  client?: EvidenceClient;
  /** The terms version the person running the agent accepts (ACCEPT_TERMS). */
  acceptTermsVersion?: string;
  /** Asks a person to approve one submission. Required for "approve". */
  confirm?: (preview: string) => Promise<boolean>;
  /** Default 5. */
  maxSubmissionsPerRun?: number;
  minConfidence?: number;
  /** How long to wait for a verdict after submitting. Default 5 minutes. */
  verdictTimeoutMs?: number;
  log?: (...args: unknown[]) => void;
  now?: () => number;
}

export interface SubmissionRunSummary {
  candidates: number;
  eligible: number;
  skipped: number;
  /** Dry-run: notes that would have been sent. */
  previewed: number;
  declined: number;
  submitted: number;
  judged: number;
  rejected: number;
  failed: number;
  resumed: number;
  stoppedReason?: string;
}

const NOTE_LIMIT = 1500;

/**
 * Builds the note the judge reads. The judge fetches each link once with a
 * basic fetch, so the note carries the key text itself: if the page is
 * paywalled or blocks bots, the quote and date are still there.
 */
export function composeNote(candidate: SubmissionCandidate): string {
  const published = candidate.publishedAt
    ? ` (published ${candidate.publishedAt.slice(0, 10)})`
    : "";

  const lines = [
    `As of ${candidate.asOfDate}: ${candidate.fact}`,
    `Source: ${candidate.publisher}${published}: "${candidate.quote}"`,
  ];

  if (candidate.corroboratedBy) {
    lines.push(`Also reported by ${candidate.corroboratedBy.publisher} (link 2).`);
  }

  if (candidate.rationale) {
    lines.push(`Relevance: ${candidate.rationale}`);
  }

  const note = lines.join("\n");

  return note.length <= NOTE_LIMIT ? note : `${note.slice(0, NOTE_LIMIT - 1)}…`;
}

function preview(candidate: SubmissionCandidate, note: string): string {
  return [
    `Market:    ${candidate.marketQuestion}`,
    `Address:   ${candidate.marketAddress}`,
    `Direction: ${candidate.direction?.toUpperCase() ?? "none"}  (confidence ${candidate.confidence.toFixed(2)})`,
    `Link:      ${candidate.sourceUrl}`,
    "Note:",
    ...note.split("\n").map((line) => `  ${line}`),
  ].join("\n");
}

/**
 * Breadth first: every market's best candidate comes before any market's
 * second best. Prizes need judged submissions across 3+ markets, and
 * within a market the strongest evidence sets the direction.
 */
export function orderCandidates(
  candidates: SubmissionCandidate[],
): SubmissionCandidate[] {
  const strength = (c: SubmissionCandidate) => c.valueScore ?? c.confidence;
  const byConfidence = [...candidates].sort((a, b) => strength(b) - strength(a));
  const rankInMarket = new Map<SubmissionCandidate, number>();
  const seen = new Map<string, number>();

  for (const candidate of byConfidence) {
    const key = candidate.marketAddress.toLowerCase();
    const rank = seen.get(key) ?? 0;

    rankInMarket.set(candidate, rank);
    seen.set(key, rank + 1);
  }

  return byConfidence.sort(
    (a, b) =>
      rankInMarket.get(a)! - rankInMarket.get(b)! || strength(b) - strength(a),
  );
}

/** Errors that mean "nothing landed, and sending again later is fine". */
function isRetryLater(error: unknown): boolean {
  if (error instanceof EvidenceApiError) {
    return error.retryable || error.code === "rate_limited" || error.status >= 500;
  }

  // Network failure or timeout: the submit may or may not have landed.
  // Resending with the same idempotency key is safe either way.
  return true;
}

/** Ensures the account has accepted the current terms, or explains how to. */
export async function ensureTermsAccepted(
  client: EvidenceClient,
  acceptTermsVersion: string | undefined,
  log: (...args: unknown[]) => void,
): Promise<boolean> {
  const { data: terms } = await client.getTerms();

  if (terms.acceptedAt !== null) {
    return true;
  }

  if (acceptTermsVersion !== terms.version) {
    log(
      `The evidence terms are not accepted yet. Read them at ${terms.url}, ` +
        `then set ACCEPT_TERMS=${terms.version} to accept them.`,
    );

    return false;
  }

  await client.acceptTerms(terms.version);
  log(`Accepted the evidence terms ${terms.version}`);

  return true;
}

/** Polls submissions still being judged and records their verdicts. */
export async function refreshVerdicts(
  client: EvidenceClient,
  history: SubmissionHistory,
  log: (...args: unknown[]) => void = console.log,
): Promise<SubmissionRecord[]> {
  const updated: SubmissionRecord[] = [];

  for (const record of history.awaitingVerdict()) {
    if (!record.submissionId) {
      continue;
    }

    try {
      const { data } = await client.getSubmission(record.submissionId);
      const next = history.applySubmission(record.idempotencyKey, data);

      updated.push(next);
      log(`${record.submissionId}: ${next.status}${next.verdict ? ` (${next.verdict})` : ""}`);
    } catch (error) {
      log(
        `Could not refresh ${record.submissionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return updated;
}

async function sendAndTrack(
  client: EvidenceClient,
  history: SubmissionHistory,
  record: SubmissionRecord,
  verdictTimeoutMs: number,
  summary: SubmissionRunSummary,
  log: (...args: unknown[]) => void,
): Promise<"ok" | "stop"> {
  history.update(record.idempotencyKey, { attempts: record.attempts + 1 });

  try {
    const { data } = await client.submitEvidence({
      note: record.note,
      links: record.links,
      marketAddress: record.marketAddress,
      idempotencyKey: record.idempotencyKey,
    });

    history.applySubmission(record.idempotencyKey, data);
    summary.submitted++;
    log(`Submitted ${data.id} (${data.status})`);

    if (data.status === "rejected") {
      summary.rejected++;
      return "ok";
    }

    try {
      const { data: final } = await client.waitForSubmission(data.id, {
        timeoutMs: verdictTimeoutMs,
      });
      const saved = history.applySubmission(record.idempotencyKey, final);

      if (final.status === "judged") {
        summary.judged++;
      } else if (final.status === "rejected") {
        summary.rejected++;
      } else {
        summary.failed++;
      }

      log(
        `Result: ${saved.status}` +
          (saved.verdict ? `, verdict ${saved.verdict}` : "") +
          (saved.bounty ? `, reward ${saved.bounty.amount} (${saved.bounty.state})` : "") +
          (saved.reason ? `\n  Reason: ${saved.reason}` : ""),
      );
    } catch (error) {
      log(
        `Still judging ${data.id}; run AGENT_MODE=status later to record the verdict ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }

    return "ok";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof TermsNotAcceptedError) {
      history.update(record.idempotencyKey, { lastError: message });
      log("Stopped: the evidence terms are not accepted.");
      return "stop";
    }

    if (isRetryLater(error)) {
      // Stays "pending": the next run resends with the same key.
      history.update(record.idempotencyKey, { lastError: message });
      log(`Submit did not complete; it will be retried with the same key next run: ${message}`);
      return error instanceof EvidenceApiError && error.code === "rate_limited"
        ? "stop"
        : "ok";
    }

    history.update(record.idempotencyKey, { status: "failed", lastError: message });
    summary.failed++;
    log(`Submit refused: ${message}`);

    return "ok";
  }
}

export async function runSubmissions(
  options: SubmissionRunOptions,
): Promise<SubmissionRunSummary> {
  const {
    candidates,
    history,
    mode,
    client,
    log = console.log,
    now = Date.now,
    maxSubmissionsPerRun = 5,
    verdictTimeoutMs = 300_000,
  } = options;

  const summary: SubmissionRunSummary = {
    candidates: candidates.length,
    eligible: 0,
    skipped: 0,
    previewed: 0,
    declined: 0,
    submitted: 0,
    judged: 0,
    rejected: 0,
    failed: 0,
    resumed: 0,
  };

  const live = mode !== "dry-run";

  if (live && !client) {
    throw new Error(`Submission mode "${mode}" needs a Delphi API client`);
  }

  if (mode === "approve" && !options.confirm) {
    throw new Error('Submission mode "approve" needs a confirm function');
  }

  if (live && client) {
    if (!(await ensureTermsAccepted(client, options.acceptTermsVersion, log))) {
      summary.stoppedReason = "terms not accepted";
      return summary;
    }

    // Finish anything a previous run left unconfirmed, with its original key.
    for (const record of history.pending()) {
      log(`\nResending unconfirmed submission ${record.idempotencyKey} (same idempotency key)`);
      summary.resumed++;

      if (
        (await sendAndTrack(client, history, record, verdictTimeoutMs, summary, log)) ===
        "stop"
      ) {
        summary.stoppedReason = "stopped while resending";
        return summary;
      }
    }
  }

  let limits: EvidenceLimits | undefined;

  if (client) {
    try {
      limits = (await client.getLimits()).data;
      log(
        `Limits: ${limits.submitsLeftThisHour} left this hour, ${limits.dailyCapLeft} left today`,
      );
    } catch (error) {
      log(`Could not read limits: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ordered = orderCandidates(candidates);

  // Submissions planned in this run count like history, so the cap,
  // direction and repeat rules also hold within a single run.
  const planned: SubmissionRecord[] = [];
  const marketState = new Map<string, { entry?: EntryState; notes: string[] }>();
  let sentThisRun = 0;

  for (const candidate of ordered) {
    const marketKey = candidate.marketAddress.toLowerCase();

    if (!marketState.has(marketKey)) {
      const state: { entry?: EntryState; notes: string[] } = { notes: [] };

      if (client) {
        try {
          state.entry = (await client.getEntryState(candidate.marketAddress)).data;
        } catch (error) {
          log(`Could not read entry state for ${candidate.marketAddress}: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }

        try {
          const { data } = await client.listSubmissions({ market: candidate.marketAddress });
          state.notes = data.items
            .map((item) => item.note)
            .filter((note): note is string => typeof note === "string");
        } catch (error) {
          log(`Could not list past submissions for ${candidate.marketAddress}: ${
            error instanceof Error ? error.message : String(error)
          }`);
        }
      }

      marketState.set(marketKey, state);
    }

    const state = marketState.get(marketKey)!;
    const marketPlanned = planned.filter(
      (record) => record.marketAddress.toLowerCase() === marketKey,
    );

    const result = checkEligibility(candidate, {
      now: now(),
      history: [...history.forMarket(candidate.marketAddress), ...marketPlanned],
      accountNotes: state.notes,
      entryState: state.entry,
      limits,
      minConfidence: options.minConfidence,
    });

    if (!result.eligible) {
      summary.skipped++;
      log(`\nSKIP ${candidate.marketQuestion}\n  ${candidate.fact}`);

      for (const reason of result.reasons) {
        log(`  - ${reason}`);
      }

      continue;
    }

    summary.eligible++;

    if (sentThisRun >= maxSubmissionsPerRun) {
      log(`\nReached the limit of ${maxSubmissionsPerRun} submission(s) for this run.`);
      summary.stoppedReason = "per-run limit reached";
      break;
    }

    const note = composeNote(candidate);
    const text = preview(candidate, note);
    const record: Omit<SubmissionRecord, "createdAt" | "updatedAt" | "attempts" | "status"> = {
      idempotencyKey: randomUUID(),
      marketAddress: candidate.marketAddress,
      marketQuestion: candidate.marketQuestion,
      direction: candidate.direction!,
      fact: candidate.fact,
      asOfDate: candidate.asOfDate,
      sourceUrl: candidate.sourceUrl,
      publisher: candidate.publisher,
      note,
      links: [candidate.sourceUrl, ...(candidate.supportingLinks ?? [])].slice(0, 5),
    };

    if (mode === "dry-run") {
      log(`\nWOULD SUBMIT\n${text}`);
      summary.previewed++;
      sentThisRun++;
      planned.push({
        ...record,
        status: "pending",
        attempts: 0,
        createdAt: "",
        updatedAt: "",
      });
      continue;
    }

    if (mode === "approve") {
      log(`\nREADY TO SUBMIT\n${text}`);

      if (!(await options.confirm!(text))) {
        summary.declined++;
        log("Declined.");
        continue;
      }
    }

    const saved = history.add(record);
    sentThisRun++;

    const outcome = await sendAndTrack(client!, history, saved, verdictTimeoutMs, summary, log);

    if (state.entry) {
      state.entry = {
        ...state.entry,
        remainingOnMarket: state.entry.remainingOnMarket - 1,
      };
    }

    if (limits) {
      limits = { ...limits, submitsLeftThisHour: limits.submitsLeftThisHour - 1 };
    }

    if (outcome === "stop") {
      summary.stoppedReason = "stopped by the API";
      break;
    }
  }

  return summary;
}
