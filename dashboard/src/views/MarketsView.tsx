import { useState } from "react";

import { formatDate, formatTime } from "../format";
import type { MarketRun, RunRecord } from "../types";
import { StatusWord } from "../ui";

export function MarketsView({ record, go }: { record: RunRecord | null; go: (route: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);

  if (!record) {
    return (
      <div className="view">
        <h2 className="view-title">Markets</h2>
        <p className="empty">No run yet. Markets appear here after the first evidence search or live check.</p>
      </div>
    );
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h2 className="view-title">Markets</h2>
          <p className="view-lede muted">
            {record.metrics.marketsDiscovered} discovered, {record.metrics.marketsOpen} open for evidence,{" "}
            {record.metrics.marketsResearched} researched in the run of {formatTime(record.finishedAt)}
            {record.kind === "live-check" ? " (live check on sample markets)" : ""}.
          </p>
        </div>
      </header>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col" className="num">YES</th>
              <th scope="col">Evidence deadline</th>
              <th scope="col">Research</th>
              <th scope="col" className="num">Findings</th>
              <th scope="col" className="num">Submittable</th>
            </tr>
          </thead>
          <tbody>
            {record.markets.map((market) => (
              <MarketRow
                key={market.address}
                market={market}
                researchedAt={record.finishedAt}
                open={open === market.address}
                onToggle={() => setOpen(open === market.address ? null : market.address)}
                onShowEvidence={() => go(`evidence?market=${market.address}`)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MarketRow({
  market,
  researchedAt,
  open,
  onToggle,
  onShowEvidence,
}: {
  market: MarketRun;
  researchedAt: string;
  open: boolean;
  onToggle: () => void;
  onShowEvidence: () => void;
}) {
  return (
    <>
      <tr className={open ? "row open" : "row"}>
        <td>
          <button type="button" className="row-toggle" aria-expanded={open} onClick={onToggle}>
            {market.question}
          </button>
          <span className="cell-sub">Status: {market.status}</span>
        </td>
        <td className="num">{Math.round(market.yesProbability * 100)}%</td>
        <td>{formatDate(market.evidenceCutoffAt)}</td>
        <td>
          {market.researched ? (
            <StatusWord tone="good">Researched</StatusWord>
          ) : (
            <StatusWord tone="quiet">Not researched</StatusWord>
          )}
          <span className="cell-sub">{market.researched ? formatTime(researchedAt) : market.skipReason}</span>
        </td>
        <td className="num">{market.findingCount}</td>
        <td className="num">{market.candidateCount}</td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={6}>
            <div className="market-detail">
              <section>
                <h4>Resolution criteria</h4>
                <p>{market.criteria ?? "None: this market was not researched."}</p>
                <p className="muted small">
                  {market.criteriaSource === "supplied"
                    ? "Supplied in RESOLUTION_CRITERIA_JSON."
                    : market.criteriaSource === "question"
                      ? "No separate criteria were supplied, so the market question is used as the criteria."
                      : ""}
                </p>
                {market.dataSources.length > 0 && (
                  <p className="small">Data sources named by the market: {market.dataSources.join(", ")}</p>
                )}
              </section>
              <section>
                <h4>What decides it</h4>
                {market.spec ? (
                  <dl className="spec">
                    <dt>Subject</dt>
                    <dd>{market.spec.subject}</dd>
                    <dt>Event</dt>
                    <dd>{market.spec.event}</dd>
                    <dt>Measurable outcome</dt>
                    <dd>{market.spec.measurableOutcome}</dd>
                    <dt>Deadline</dt>
                    <dd>{market.spec.deadline}</dd>
                    <dt>Geography</dt>
                    <dd>{market.spec.geography}</dd>
                    <dt>Clarity</dt>
                    <dd>
                      {market.spec.clarity === "ambiguous" ? (
                        <StatusWord tone="warn">Ambiguous</StatusWord>
                      ) : (
                        <StatusWord tone="good">Clear</StatusWord>
                      )}{" "}
                      {market.spec.notes}
                    </dd>
                  </dl>
                ) : (
                  <p className="muted small">
                    No structured reading: it comes from the LLM query planner, which did not run for this market.
                  </p>
                )}
              </section>
            </div>
            {market.findingCount > 0 && (
              <button type="button" className="link-button" onClick={onShowEvidence}>
                Show this market's {market.findingCount} findings
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
