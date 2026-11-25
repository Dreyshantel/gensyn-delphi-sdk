/**
 * Candidates waiting for a person to submit or skip them in the dashboard.
 *
 * A research run (always dry-run) fills the queue; the person decides per
 * candidate. Stored next to the submission history as JSON so it survives
 * restarts of the dashboard server.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { SubmissionCandidate } from "./submission-eligibility.js";

export const DEFAULT_QUEUE_PATH = ".delphi-agent/review-queue.json";

export type QueueItemState = "waiting" | "submitted" | "skipped";

export interface QueueItem {
  id: string;
  addedAt: string;
  state: QueueItemState;
  candidate: SubmissionCandidate;
  /** Set after a submit attempt: the idempotency key of the history record. */
  idempotencyKey?: string;
}

interface QueueFile {
  version: 1;
  items: QueueItem[];
}

/** Same market, source and fact give the same id, so a rerun does not duplicate an item. */
export function candidateId(candidate: SubmissionCandidate): string {
  return createHash("sha256")
    .update(`${candidate.marketAddress.toLowerCase()}|${candidate.sourceUrl}|${candidate.fact}`)
    .digest("hex")
    .slice(0, 16);
}

export class ReviewQueue {
  private constructor(
    private readonly path: string | null,
    private readonly items: QueueItem[],
    private readonly now: () => number,
  ) {}

  static load(path = DEFAULT_QUEUE_PATH, now: () => number = Date.now): ReviewQueue {
    if (!existsSync(path)) {
      return new ReviewQueue(path, [], now);
    }

    const file = JSON.parse(readFileSync(path, "utf8")) as Partial<QueueFile>;

    if (file.version !== 1 || !Array.isArray(file.items)) {
      throw new Error(`Review queue at ${path} has an unknown format`);
    }

    return new ReviewQueue(path, file.items, now);
  }

  static inMemory(now: () => number = Date.now): ReviewQueue {
    return new ReviewQueue(null, [], now);
  }

  all(): QueueItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  get(id: string): QueueItem | undefined {
    const item = this.items.find((entry) => entry.id === id);

    return item ? { ...item } : undefined;
  }

  /** Adds new candidates; ones already queued (in any state) are left as they are. */
  addCandidates(candidates: SubmissionCandidate[]): number {
    let added = 0;

    for (const candidate of candidates) {
      const id = candidateId(candidate);

      if (this.items.some((item) => item.id === id)) {
        continue;
      }

      this.items.push({
        id,
        addedAt: new Date(this.now()).toISOString(),
        state: "waiting",
        candidate,
      });
      added++;
    }

    this.save();

    return added;
  }

  setState(id: string, state: QueueItemState, idempotencyKey?: string): QueueItem {
    const item = this.items.find((entry) => entry.id === id);

    if (!item) {
      throw new Error(`No queue item ${id}`);
    }

    item.state = state;

    if (idempotencyKey) {
      item.idempotencyKey = idempotencyKey;
    }

    this.save();

    return { ...item };
  }

  private save(): void {
    if (this.path === null) {
      return;
    }

    mkdirSync(dirname(this.path), { recursive: true });

    const temporary = `${this.path}.tmp`;
    const file: QueueFile = { version: 1, items: this.items };

    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }
}
