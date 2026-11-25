import { useState } from "react";

import type { QueueItem } from "./types";
import { formatDate } from "./format";

interface Props {
  item: QueueItem;
  canSubmit: boolean;
  busy: boolean;
  onSubmit: (item: QueueItem) => void;
  onSkip: (item: QueueItem) => void;
}

export function EvidenceEntry({ item, canSubmit, busy, onSubmit, onSkip }: Props) {
  const [showNote, setShowNote] = useState(false);
  const { candidate } = item;
  const direction = candidate.direction;

  return (
    <article className={item.eligible ? "entry" : "entry blocked"}>
      <header className="entry-head">
        <p className="entry-market">{candidate.marketQuestion}</p>
        <div className="entry-call">
          {direction ? (
            <span className={`direction ${direction}`}>Points {direction.toUpperCase()}</span>
          ) : (
            <span className="direction none">No direction</span>
          )}
          <span className="confidence" title="The model's confidence that this fact moves the outcome">
            {Math.round(candidate.confidence * 100)}% sure
          </span>
        </div>
      </header>

      <p className="entry-date">As of {formatDate(candidate.asOfDate)}</p>
      <p className="entry-fact">{candidate.fact}</p>
      <blockquote className="entry-quote">{candidate.quote}</blockquote>

      <p className="entry-source">
        <a href={candidate.sourceUrl} target="_blank" rel="noreferrer noopener">
          {candidate.publisher}
        </a>
        {candidate.publishedAt && <span>, published {formatDate(candidate.publishedAt)}</span>}
      </p>

      {candidate.rationale && <p className="entry-why">{candidate.rationale}</p>}

      {!item.eligible && (
        <ul className="entry-blocked" aria-label="Why this note can't be submitted">
          {item.blockedBy.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      <footer className="entry-actions">
        <button type="button" className="link-button" onClick={() => setShowNote((v) => !v)} aria-expanded={showNote}>
          {showNote ? "Hide the note" : "Show the exact note"}
        </button>
        <div className="entry-buttons">
          <button type="button" className="quiet" disabled={busy} onClick={() => onSkip(item)}>
            Skip
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !item.eligible || !canSubmit}
            title={!canSubmit ? "Add your Delphi API key to .env to submit" : undefined}
            onClick={() => onSubmit(item)}
          >
            Submit note
          </button>
        </div>
      </footer>

      {showNote && <pre className="entry-note">{item.note}</pre>}
    </article>
  );
}
