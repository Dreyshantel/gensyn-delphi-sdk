import { useMemo, useState } from "react";

import { EvidenceEntry } from "../EvidenceEntry";
import { formatDate } from "../format";
import type { Finding, FindingStatus, QueueItem, Relationship, RunRecord, RunSummary } from "../types";
import {
  CREDIBILITY_LABEL,
  DirectionMark,
  RELATIONSHIP_LABEL,
  RunPicker,
  STATUS_LABEL,
  ScoreBreakdown,
  StatusWord,
  findingTone,
  pct,
} from "../ui";

interface Props {
  queue: QueueItem[];
  canSubmit: boolean;
  busyId: string | null;
  onSubmit: (item: QueueItem) => void;
  onSkip: (item: QueueItem) => void;
  runs: RunSummary[];
  record: RunRecord | null;
  selected: string | null;
  onSelect: (id: string) => void;
  initialMarket?: string;
}

const STATUS_ORDER: FindingStatus[] = [
  "candidate",
  "duplicate_fact",
  "non_directional",
  "needs_primary_source",
  "failed_checks",
  "syndicated_copy",
  "already_submitted",
  "not_selected",
  "screened_out",
  "budget_exhausted",
];

export function EvidenceView(props: Props) {
  const { record } = props;
  const [status, setStatus] = useState<string>("assessed");
  const [direction, setDirection] = useState<string>("all");
  const [relationship, setRelationship] = useState<string>("all");
  const [market, setMarket] = useState<string>(props.initialMarket ?? "all");

  const findings = useMemo(() => {
    const all = record?.findings ?? [];

    return all
      .filter((f) =>
        status === "all"
          ? true
          : status === "assessed"
            ? f.relationship !== undefined || f.status === "failed_checks"
            : f.status === status,
      )
      .filter((f) => (direction === "all" ? true : direction === "none" ? !f.direction : f.direction === direction))
      .filter((f) => (relationship === "all" ? true : f.relationship === relationship))
      .filter((f) => (market === "all" ? true : f.marketAddress.toLowerCase() === market.toLowerCase()))
      .sort(
        (a, b) =>
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
          (b.valueScore ?? 0) - (a.valueScore ?? 0),
      );
  }, [record, status, direction, relationship, market]);

  const markets = record?.markets.filter((m) => m.findingCount > 0) ?? [];

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h2 className="view-title">Evidence</h2>
          <p className="view-lede muted">Notes waiting for your decision, then every article the last run assessed and what happened to it.</p>
        </div>
      </header>

      <aside className="notice">
        <p>
          <strong>Scores rank evidence; they do not verify it.</strong> Keyword relevance, the model's confidence and the
          value score only order findings. The quote check proves the quoted text is in the source and the dates are
          consistent, not that the source is right. Read the source before you submit.
        </p>
      </aside>

      <section className="evidence-section" aria-labelledby="review-title">
        <h3 id="review-title" className="section-title">
          Waiting for your review ({props.queue.length})
        </h3>
        {props.queue.length === 0 ? (
          <p className="empty">No notes to review. Run Find evidence from the Dashboard to draft some.</p>
        ) : (
          <div className="entries">
            {props.queue.map((item) => (
              <EvidenceEntry
                key={item.id}
                item={item}
                canSubmit={props.canSubmit}
                busy={props.busyId !== null}
                onSubmit={props.onSubmit}
                onSkip={props.onSkip}
              />
            ))}
          </div>
        )}
      </section>

      <section className="evidence-section" aria-labelledby="findings-title">
        <div className="section-head">
          <h3 id="findings-title" className="section-title">
            Findings in this run ({findings.length})
          </h3>
          <RunPicker runs={props.runs} selected={props.selected} onSelect={props.onSelect} />
        </div>

        {!record ? (
          <p className="empty">No runs yet.</p>
        ) : (
          <>
            <div className="filters" role="group" aria-label="Filter findings">
              <label>
                <span>Outcome</span>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="assessed">Assessed by the LLM</option>
                  <option value="all">All articles</option>
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]} ({record.metrics.findingsByStatus[s] ?? 0})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Direction</span>
                <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                  <option value="all">Any</option>
                  <option value="yes">YES</option>
                  <option value="no">NO</option>
                  <option value="none">Not established</option>
                </select>
              </label>
              <label>
                <span>Relationship</span>
                <select value={relationship} onChange={(e) => setRelationship(e.target.value)}>
                  <option value="all">Any</option>
                  {(Object.keys(RELATIONSHIP_LABEL) as Relationship[]).map((r) => (
                    <option key={r} value={r}>
                      {RELATIONSHIP_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Market</span>
                <select value={market} onChange={(e) => setMarket(e.target.value)}>
                  <option value="all">All markets</option>
                  {markets.map((m) => (
                    <option key={m.address} value={m.address}>
                      {m.question.length > 60 ? `${m.question.slice(0, 58)}…` : m.question}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {findings.length === 0 ? (
              <p className="empty">No findings match these filters.</p>
            ) : (
              <div className="findings">
                {findings.map((f) => (
                  <FindingCard key={f.id} finding={f} />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function FindingCard({ finding: f }: { finding: Finding }) {
  return (
    <article className="finding">
      <header className="finding-head">
        <p className="entry-market">{f.marketQuestion}</p>
        <div className="finding-tags">
          <DirectionMark direction={f.direction} />
          {f.relationship && <span className="tag">{RELATIONSHIP_LABEL[f.relationship]}</span>}
        </div>
      </header>

      <p className="finding-claim">{f.fact ?? f.title}</p>
      {f.quote && <blockquote className="entry-quote">{f.quote}</blockquote>}

      <dl className="finding-meta">
        <div>
          <dt>Source</dt>
          <dd>
            <a href={f.url} target="_blank" rel="noreferrer noopener">
              {f.publisher}
            </a>{" "}
            <span className="muted">{CREDIBILITY_LABEL[f.credibility]}</span>
            {f.corroboratedBy && (
              <>
                <br />
                Confirmed by{" "}
                <a href={f.corroboratedBy.url} target="_blank" rel="noreferrer noopener">
                  {f.corroboratedBy.publisher}
                </a>{" "}
                <span className="muted">{CREDIBILITY_LABEL[f.corroboratedBy.credibility]}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>
            {f.publishedAt ? formatDate(f.publishedAt) : "Unknown"}
            {f.publishedAtSource === "search" && <span className="muted"> (search listing date, not from the page)</span>}
          </dd>
        </div>
        <div>
          <dt>Event date</dt>
          <dd>{f.asOfDate ? formatDate(f.asOfDate) : "Not established"}</dd>
        </div>
        <div>
          <dt>Keyword relevance</dt>
          <dd>{pct(f.ruleRelevance)}</dd>
        </div>
        <div>
          <dt>Model confidence</dt>
          <dd>{f.confidence !== undefined ? pct(f.confidence) : "n/a"}</dd>
        </div>
        <div>
          <dt>Outcome</dt>
          <dd>
            <StatusWord tone={findingTone(f.status)}>{STATUS_LABEL[f.status]}</StatusWord>
          </dd>
        </div>
      </dl>

      {f.reasons.length > 0 && (
        <ul className="finding-reasons">
          {f.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      {(f.rationale || (f.limitations && f.limitations.length > 0) || f.scoreParts) && (
        <details className="finding-more">
          <summary>Why it matters, limitations and score</summary>
          <div className="finding-more-body">
            {f.rationale && (
              <p>
                <strong>Assessment: </strong>
                {f.rationale}
              </p>
            )}
            {f.limitations && f.limitations.length > 0 && (
              <>
                <p>
                  <strong>Limitations</strong>
                </p>
                <ul>
                  {f.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </>
            )}
            {f.scoreParts && f.valueScore !== undefined && <ScoreBreakdown parts={f.scoreParts} total={f.valueScore} />}
          </div>
        </details>
      )}
    </article>
  );
}
