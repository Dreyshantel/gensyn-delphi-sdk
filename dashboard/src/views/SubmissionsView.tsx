import { HistoryList } from "../HistoryList";
import { formatUsd } from "../format";
import type { Overview, SubmissionRecord } from "../types";

interface Props {
  overview: Overview;
  records: SubmissionRecord[];
  refreshing: boolean;
  canRefresh: boolean;
  onRefresh: () => void;
}

const STATUSES = ["pending", "queued", "judging", "judged", "rejected", "failed", "unmatched"] as const;
const LABEL: Record<(typeof STATUSES)[number], string> = {
  pending: "Not confirmed",
  queued: "Queued",
  judging: "Being judged",
  judged: "Judged",
  rejected: "Rejected",
  failed: "Failed",
  unmatched: "Unmatched",
};

export function SubmissionsView({ overview, records, refreshing, canRefresh, onRefresh }: Props) {
  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h2 className="view-title">Submissions</h2>
          <p className="view-lede muted">
            Everything sent to Delphi, with the judge's verdict, reasoning and reward. Rewards are paid 24 hours after
            judging; a settlement reward can follow when the market settles.
          </p>
        </div>
        <button type="button" className="quiet" onClick={onRefresh} disabled={refreshing || !canRefresh}>
          {refreshing ? "Checking…" : "Check verdicts"}
        </button>
      </header>

      <dl className="figures status-strip">
        {STATUSES.map((s) => (
          <div key={s}>
            <dt>{LABEL[s]}</dt>
            <dd>{records.filter((r) => r.status === s).length}</dd>
          </div>
        ))}
        <div>
          <dt>Rewards</dt>
          <dd className="small-dd">{formatUsd(overview.rewards.held + overview.rewards.paid)}</dd>
        </div>
      </dl>

      <HistoryList records={records} />
    </div>
  );
}
