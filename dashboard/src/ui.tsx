import type { CredibilityTier, Direction, FindingStatus, Relationship, RunSummary, ScoreParts } from "./types";
import { formatTime } from "./format";

export const RELATIONSHIP_LABEL: Record<Relationship, string> = {
  direct_support: "Supports YES",
  contradiction: "Supports NO",
  context: "Context",
  inconclusive: "Inconclusive",
  irrelevant: "Irrelevant",
};

export const STATUS_LABEL: Record<FindingStatus, string> = {
  candidate: "Submittable",
  duplicate_fact: "Repeats another finding",
  non_directional: "No direction",
  failed_checks: "Failed checks",
  syndicated_copy: "Syndicated copy",
  screened_out: "Screened out",
  not_selected: "Not read",
  needs_primary_source: "Needs primary source",
  already_submitted: "Already submitted",
  budget_exhausted: "Not read: budget",
};

export const CREDIBILITY_LABEL: Record<CredibilityTier, string> = {
  primary: "Primary source",
  established: "Established outlet",
  unknown: "Unrated outlet",
  low: "Low credibility",
};

export const SCORE_LABEL: Record<keyof ScoreParts, string> = {
  impact: "Impact",
  credibility: "Credibility",
  freshness: "Freshness",
  specificity: "Specificity",
  relevance: "Keyword relevance",
};

export const SCORE_WEIGHT: Record<keyof ScoreParts, number> = {
  impact: 0.3,
  credibility: 0.2,
  freshness: 0.2,
  specificity: 0.15,
  relevance: 0.15,
};

export function DirectionMark({ direction }: { direction?: Direction }) {
  if (!direction) {
    return <span className="direction none">Not established</span>;
  }

  return <span className={`direction ${direction}`}>{direction.toUpperCase()}</span>;
}

/** A status shown as a word with a shape, never colour alone. */
export function StatusWord({ tone, children }: { tone: "good" | "warn" | "bad" | "quiet"; children: string }) {
  const shape = { good: "●", warn: "▲", bad: "■", quiet: "○" }[tone];

  return (
    <span className={`status-word tone-${tone}`}>
      <span aria-hidden="true">{shape}</span> {children}
    </span>
  );
}

export function findingTone(status: FindingStatus): "good" | "warn" | "bad" | "quiet" {
  if (status === "candidate") return "good";
  if (status === "failed_checks") return "bad";
  if (status === "duplicate_fact" || status === "syndicated_copy" || status === "budget_exhausted" || status === "needs_primary_source") return "warn";
  return "quiet";
}

export interface BarDatum {
  label: string;
  value: number;
  note?: string;
}

/**
 * One series of horizontal bars. Magnitude in a single hue; identity in
 * text; every value labelled, and a tooltip on hover.
 */
export function BarList({ data, unit = "", max }: { data: BarDatum[]; unit?: string; max?: number }) {
  const top = max ?? Math.max(1, ...data.map((d) => d.value));

  return (
    <dl className="bars">
      {data.map((d) => (
        <div key={d.label} className="bar-row" title={`${d.label}: ${d.value}${unit}${d.note ? ` (${d.note})` : ""}`}>
          <dt>
            {d.label}
            {d.note && <span className="bar-note"> ({d.note})</span>}
          </dt>
          <dd>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: `${Math.max(d.value > 0 ? 1.5 : 0, (d.value / top) * 100)}%` }} />
            </span>
            <span className="bar-value">
              {d.value}
              {unit}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ScoreBreakdown({ parts, total }: { parts: ScoreParts; total: number }) {
  return (
    <div className="score">
      <p className="score-total">
        Value score <strong>{total.toFixed(2)}</strong>
      </p>
      <dl className="score-parts">
        {(Object.keys(SCORE_WEIGHT) as (keyof ScoreParts)[]).map((key) => (
          <div key={key} title={`${SCORE_LABEL[key]}: ${parts[key].toFixed(2)} × weight ${SCORE_WEIGHT[key]}`}>
            <dt>
              {SCORE_LABEL[key]} <span className="weight">×{SCORE_WEIGHT[key]}</span>
            </dt>
            <dd>
              <span className="bar-track small">
                <span className="bar-fill" style={{ width: `${Math.round(parts[key] * 100)}%` }} />
              </span>
              <span className="bar-value">{parts[key].toFixed(2)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function RunPicker({
  runs,
  selected,
  onSelect,
}: {
  runs: RunSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (runs.length === 0) {
    return null;
  }

  return (
    <label className="run-picker">
      <span>Run</span>
      <select value={selected ?? ""} onChange={(e) => onSelect(e.target.value)}>
        {runs.map((run) => (
          <option key={run.id} value={run.id}>
            {formatTime(run.finishedAt)} {run.kind === "live-check" ? "(live check)" : run.mode === "dry-run" ? "(dry run)" : `(${run.mode})`}
          </option>
        ))}
      </select>
    </label>
  );
}

export const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
