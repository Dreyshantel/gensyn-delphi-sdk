/**
 * Persistent record of every submission this agent prepares or sends.
 *
 * Stored as one JSON file (default `.delphi-agent/submissions.json`) so it
 * survives restarts and can be read by a person. It is what lets the
 * agent:
 *   - retry a timed-out submit with the SAME Idempotency-Key, so a
 *     submission that already landed is returned instead of using a new
 *     slot (see the competition FAQ),
 *   - never send the same fact to a market twice,
 *   - keep every submission on a market pointing the same way
 *     (evidence for both sides cancels out),
 *   - track verdicts and rewards after judging.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import type { Submission, SubmissionStatus } from "../../src/index.js";
import type { EvidenceDirection } from "./evidence-assessor.js";

export const DEFAULT_HISTORY_PATH = ".delphi-agent/submissions.json";

/**
 * - `pending`: saved locally, submit not yet confirmed by the API.
 *   Safe to resend with the same idempotency key.
 * - any API status once the API has answered.
 */
export type LocalSubmissionStatus = "pending" | SubmissionStatus;

export interface SubmissionRecord {
  /** Also used as the Idempotency-Key header. */
  idempotencyKey: string;
  marketAddress: string;
  marketQuestion: string;
  direction: EvidenceDirection;
  fact: string;
  asOfDate: string;
  sourceUrl: string;
  publisher: string;
  note: string;
  links: string[];
  status: LocalSubmissionStatus;
  submissionId?: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  verdict?: string | null;
  reason?: string | null;
  bounty?: { amount: string; state: string } | null;
  zeroPayReason?: string;
  lastError?: string;
}

interface HistoryFile {
  version: 1;
  records: SubmissionRecord[];
}

const TERMINAL: LocalSubmissionStatus[] = [
  "judged",
  "rejected",
  "failed",
  "unmatched",
];

export function isTerminalStatus(status: LocalSubmissionStatus): boolean {
  return TERMINAL.includes(status);
}

export class SubmissionHistory {
  private constructor(
    private readonly path: string | null,
    private readonly records: SubmissionRecord[],
    private readonly now: () => number,
  ) {}

  /** Loads the history file, or starts empty when it does not exist. */
  static load(
    path = DEFAULT_HISTORY_PATH,
    now: () => number = Date.now,
  ): SubmissionHistory {
    if (!existsSync(path)) {
      return new SubmissionHistory(path, [], now);
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      // Refuse to continue rather than silently overwrite a damaged file:
      // losing history could cause duplicate or opposite-side submissions.
      throw new Error(
        `Submission history at ${path} is not valid JSON. Fix or move it before running the agent.`,
        { cause: error },
      );
    }

    const file = parsed as Partial<HistoryFile>;

    if (file.version !== 1 || !Array.isArray(file.records)) {
      throw new Error(`Submission history at ${path} has an unknown format`);
    }

    return new SubmissionHistory(path, file.records, now);
  }

  /** An in-memory history for tests and dry runs. */
  static inMemory(
    records: SubmissionRecord[] = [],
    now: () => number = Date.now,
  ): SubmissionHistory {
    return new SubmissionHistory(null, records.map((r) => ({ ...r })), now);
  }

  all(): SubmissionRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  forMarket(marketAddress: string): SubmissionRecord[] {
    const key = marketAddress.toLowerCase();

    return this.all().filter(
      (record) => record.marketAddress.toLowerCase() === key,
    );
  }

  /** Records that were saved but never confirmed by the API. */
  pending(): SubmissionRecord[] {
    return this.all().filter((record) => record.status === "pending");
  }

  /** Records the API accepted but has not finished judging. */
  awaitingVerdict(): SubmissionRecord[] {
    return this.all().filter(
      (record) =>
        record.status !== "pending" && !isTerminalStatus(record.status),
    );
  }

  add(
    record: Omit<SubmissionRecord, "createdAt" | "updatedAt" | "attempts" | "status">,
  ): SubmissionRecord {
    if (this.records.some((r) => r.idempotencyKey === record.idempotencyKey)) {
      throw new Error(`Duplicate idempotency key ${record.idempotencyKey}`);
    }

    const timestamp = new Date(this.now()).toISOString();
    const created: SubmissionRecord = {
      ...record,
      status: "pending",
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.records.push(created);
    this.save();

    return { ...created };
  }

  update(
    idempotencyKey: string,
    patch: Partial<Omit<SubmissionRecord, "idempotencyKey" | "createdAt">>,
  ): SubmissionRecord {
    const record = this.records.find((r) => r.idempotencyKey === idempotencyKey);

    if (!record) {
      throw new Error(`No submission record for key ${idempotencyKey}`);
    }

    Object.assign(record, patch, {
      updatedAt: new Date(this.now()).toISOString(),
    });

    this.save();

    return { ...record };
  }

  /** Copies the API's view of a submission into the local record. */
  applySubmission(idempotencyKey: string, submission: Submission): SubmissionRecord {
    const market = submission.markets[0];

    return this.update(idempotencyKey, {
      submissionId: submission.id,
      status: submission.status,
      verdict: market?.verdict ?? null,
      reason: market?.reason ?? null,
      bounty: market?.bounty ?? null,
      ...(market?.zeroPayReason ? { zeroPayReason: market.zeroPayReason } : {}),
      lastError: undefined,
    });
  }

  private save(): void {
    if (this.path === null) {
      return;
    }

    mkdirSync(dirname(this.path), { recursive: true });

    // Write to a temporary file first, then rename, so an interrupted
    // write never leaves a half-written history file behind.
    const temporary = `${this.path}.tmp`;
    const file: HistoryFile = { version: 1, records: this.records };

    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }
}
