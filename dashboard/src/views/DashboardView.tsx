import { Tally } from "../Tally";
import { formatTime, formatUsd } from "../format";
import type { Overview, RunState, RunSummary, SubmissionRecord } from "../types";
import { BarList, StatusWord, pct } from "../ui";

interface Props {
  overview: Overview;
  run: RunState | null;
  runs: RunSummary[];
  records: SubmissionRecord[];
  offline: string | null;
  onFindEvidence: () => void;
  go: (route: string) => void;
}

export function DashboardView({ overview, run, runs, records, offline, onFindEvidence, go }: Props) {
  const latest = overview.latestRun;
  const m = latest?.metrics;
  const config = overview.config;
  const running = run?.status === "running";

  const byStatus = (status: string) => records.filter((r) => r.status === status).length;
  const accepted = records.filter((r) => r.status === "judged" && r.verdict && /accept/i.test(r.verdict)).length;

  const warnings: { tone: "warn" | "bad"; text: string }[] = [
    ...(offline ? [{ tone: "bad" as const, text: offline }] : []),
    ...(!config.llmModel ? [{ tone: "bad" as const, text: "No LLM configured: evidence can't be assessed or submitted." }] : []),
    ...(!config.hasApiClient ? [{ tone: "warn" as const, text: "No Delphi API key: submitting and verdict checks are off." }] : []),
    ...(!config.hasSiteUrl ? [{ tone: "warn" as const, text: "No COMPETITION_SITE_URL: the agent can't find competition markets." }] : []),
    ...(run?.status === "failed" ? [{ tone: "bad" as const, text: `Last search failed: ${run.error}` }] : []),
    ...(overview.counts.pending > 0
      ? [{ tone: "warn" as const, text: `${overview.counts.pending} submission(s) not confirmed by Delphi; the next run resends them with the same key.` }]
      : []),
    ...(latest?.warnings ?? []).map((text) => ({ tone: "warn" as const, text })),
  ];

  const status = running
    ? { tone: "good" as const, text: "Searching for evidence" }
    : run?.status === "failed"
      ? { tone: "bad" as const, text: "Last search failed" }
      : !config.llmModel
        ? { tone: "warn" as const, text: "Research only (no LLM)" }
        : { tone: "quiet" as const, text: "Idle, ready to search" };

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h2 className="view-title">Dashboard</h2>
          <p className="view-lede">
            <StatusWord tone={status.tone}>{status.text}</StatusWord>
            {latest && <span className="muted"> Last run finished {formatTime(latest.finishedAt)}.</span>}
          </p>
        </div>
        <button type="button" className="primary" onClick={onFindEvidence} disabled={running || !config.hasSiteUrl}>
          {running ? "Searching…" : "Find evidence"}
        </button>
      </header>

      <div className="dash-grid">
        <section className="panel funnel-panel" aria-labelledby="funnel-title">
          <h3 id="funnel-title" className="panel-title">
            Where the last run's evidence came from
          </h3>
          {m ? (
            <>
              <BarList
                data={[
                  { label: "Sources found", value: m.sourcesFound },
                  { label: "Articles fetched", value: m.articlesFetched, note: `${pct(m.fetchSuccessRate)} fetch success` },
                  { label: "Read by the LLM", value: m.articlesSentToLlm },
                  { label: "Submittable findings", value: m.candidates, note: `${pct(m.candidateRate)} of articles read` },
                ]}
              />
              <p className="panel-foot">
                {m.marketsResearched} of {m.marketsOpen} open markets researched. Invented quotes caught:{" "}
                {m.hallucinationsCaught}. Duplicates and syndicated copies: {pct(m.duplicateRate)}.
              </p>
            </>
          ) : (
            <p className="empty">No runs yet. Use Find evidence, or run the live check, to see the pipeline here.</p>
          )}
        </section>

        <section className="panel">
          <h3 className="panel-title">Submissions</h3>
          <dl className="figures">
            <div>
              <dt>Submitted</dt>
              <dd>{records.length}</dd>
            </div>
            <div>
              <dt>Being judged</dt>
              <dd>{byStatus("queued") + byStatus("judging")}</dd>
            </div>
            <div>
              <dt>Judged</dt>
              <dd>{byStatus("judged")}</dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>{accepted}</dd>
            </div>
            <div>
              <dt>Rejected</dt>
              <dd>{byStatus("rejected")}</dd>
            </div>
            <div>
              <dt>Failed or unconfirmed</dt>
              <dd>{byStatus("failed") + byStatus("pending") + byStatus("unmatched")}</dd>
            </div>
          </dl>
          <p className="reward-line">
            <span className="reward-total">{formatUsd(overview.rewards.held + overview.rewards.paid)}</span>
            <span className="muted"> earned, {formatUsd(overview.rewards.held)} held for 24 hours</span>
          </p>
          <button type="button" className="link-button" onClick={() => go("submissions")}>
            Open submissions
          </button>
        </section>

        <section className="panel">
          <Tally {...overview.prize} />
        </section>

        <section className="panel">
          <h3 className="panel-title">Waiting for you</h3>
          <p className="big-number">{overview.counts.waitingForReview}</p>
          <p className="muted">
            {overview.counts.waitingForReview === 1 ? "note" : "notes"} drafted and waiting for your review. Nothing is
            sent until you submit it.
          </p>
          <button type="button" className="link-button" onClick={() => go("evidence")}>
            Review evidence
          </button>
        </section>
      </div>

      <div className="two-col">
        <section className="panel">
          <h3 className="panel-title">Warnings</h3>
          {warnings.length === 0 ? (
            <p className="muted">Nothing needs attention.</p>
          ) : (
            <ul className="warning-list">
              {warnings.slice(0, 8).map((w, i) => (
                <li key={i}>
                  <StatusWord tone={w.tone}>{w.tone === "bad" ? "Problem" : "Check"}</StatusWord> {w.text}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h3 className="panel-title">Recent activity</h3>
          <ol className="activity">
            {[
              ...records.slice(0, 4).map((r) => ({
                at: r.createdAt,
                text: `Submitted ${r.direction.toUpperCase()} evidence: ${r.marketQuestion}`,
                status: r.status,
              })),
              ...runs.slice(0, 4).map((r) => ({
                at: r.finishedAt,
                text: `${r.kind === "live-check" ? "Live check" : "Research run"}: ${r.metrics.marketsResearched} markets, ${r.metrics.candidates} submittable findings`,
                status: r.mode,
              })),
            ]
              .sort((a, b) => b.at.localeCompare(a.at))
              .slice(0, 6)
              .map((item, i) => (
                <li key={i}>
                  <time dateTime={item.at}>{formatTime(item.at)}</time>
                  <span>{item.text}</span>
                </li>
              ))}
            {records.length === 0 && runs.length === 0 && <li className="muted">No activity yet.</li>}
          </ol>
        </section>
      </div>
    </div>
  );
}
