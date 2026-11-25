import type { SubmissionRecord } from "./types";
import { formatTime } from "./format";

const STATUS_LABEL: Record<string, string> = {
  pending: "Not confirmed",
  queued: "Queued",
  judging: "Being judged",
  judged: "Judged",
  rejected: "Rejected",
  failed: "Failed",
  unmatched: "Unmatched",
};

export function HistoryList({ records }: { records: SubmissionRecord[] }) {
  if (records.length === 0) {
    return <p className="empty">Nothing submitted yet. Notes you submit from the review list appear here with their verdicts.</p>;
  }

  return (
    <ol className="history">
      {records.map((record) => (
        <li key={record.idempotencyKey} className="history-row">
          <div className="history-main">
            <p className="history-market">{record.marketQuestion}</p>
            <p className="history-fact">{record.fact}</p>
            {record.reason && <p className="history-reason">Judge: {record.reason}</p>}
            {record.status === "pending" && record.lastError && (
              <p className="history-reason warn">
                Not confirmed yet. The next run resends it with the same key: {record.lastError}
              </p>
            )}
            {record.zeroPayReason && <p className="history-reason">Paid 0: {record.zeroPayReason.replace(/_/g, " ")}</p>}
          </div>
          <div className="history-side">
            <span className={`status ${record.status}`}>{STATUS_LABEL[record.status] ?? record.status}</span>
            <span className={`direction small ${record.direction}`}>{record.direction.toUpperCase()}</span>
            {record.bounty && (
              <span className="reward">
                {record.bounty.amount} <span className="reward-state">{record.bounty.state}</span>
              </span>
            )}
            <time dateTime={record.createdAt}>{formatTime(record.createdAt)}</time>
            {record.submissionId && <span className="submission-id" title="Delphi submission ID">{record.submissionId}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
