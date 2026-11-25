import { RunLog } from "../RunLog";
import { formatTime } from "../format";
import type { RunRecord, RunState, RunSummary } from "../types";
import { BarList, RunPicker, StatusWord, pct } from "../ui";

interface Props {
  runs: RunSummary[];
  record: RunRecord | null;
  selected: string | null;
  onSelect: (id: string) => void;
  run: RunState | null;
  go: (route: string) => void;
}

export function ResearchView({ runs, record, selected, onSelect, run, go }: Props) {
  const running = run?.status === "running";

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h2 className="view-title">Research</h2>
          <p className="view-lede muted">What each run searched for, what it found and fetched, and where it failed.</p>
        </div>
        <RunPicker runs={runs} selected={selected} onSelect={onSelect} />
      </header>

      {(running || (run && run.log.length > 0 && !record)) && (
        <section className="panel">
          <h3 className="panel-title">{running ? "Search in progress" : "Latest search log"}</h3>
          <RunLog run={run} />
        </section>
      )}

      {!record ? (
        <p className="empty">No completed runs yet.</p>
      ) : (
        <>
          <section className="panel run-facts">
            <dl className="figures">
              <div>
                <dt>Finished</dt>
                <dd className="small-dd">{formatTime(record.finishedAt)}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{Math.round(record.metrics.durationMs / 1000)} s</dd>
              </div>
              <div>
                <dt>Search providers</dt>
                <dd className="small-dd">{record.searchProviders.join(", ")}</dd>
              </div>
              <div>
                <dt>LLM</dt>
                <dd className="small-dd">{record.llm ? record.llm.model : "Not configured"}</dd>
              </div>
              <div>
                <dt>LLM calls</dt>
                <dd>{record.metrics.llmCalls}</dd>
              </div>
              <div>
                <dt>Tokens used</dt>
                <dd>{record.metrics.llmTokens ?? "n/a"}</dd>
              </div>
            </dl>
            {record.warnings.length > 0 && (
              <ul className="warning-list">
                {record.warnings.map((w, i) => (
                  <li key={i}>
                    <StatusWord tone="warn">Check</StatusWord> {w}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {record.markets
            .filter((m) => m.research)
            .map((market) => {
              const r = market.research!;

              return (
                <details key={market.address} className="panel research-market">
                  <summary>
                    <span className="research-q">{market.question}</span>
                    <span className="research-sum muted">
                      {r.sourcesFound} sources, {r.fetched} fetched, {market.candidateCount} submittable
                    </span>
                  </summary>

                  <div className="research-body">
                    <section>
                      <h4>Searches</h4>
                      <ol className="queries">
                        {r.queries.map((q) => (
                          <li key={q}>
                            <code>{q}</code>
                          </li>
                        ))}
                      </ol>
                    </section>
                    <section>
                      <h4>Progress</h4>
                      <BarList
                        data={[
                          { label: "Sources found", value: r.sourcesFound, note: `from ${r.publishers} publishers` },
                          { label: "Articles fetched", value: r.fetched, note: `${pct(r.fetched / Math.max(1, r.fetched + r.fetchFailures.length))} success` },
                          { label: "Articles assessed", value: r.assessed },
                          { label: "Submittable findings", value: market.candidateCount },
                        ]}
                        max={Math.max(1, r.sourcesFound)}
                      />
                    </section>
                    {(r.fetchFailures.length > 0 || r.searchFailures.length > 0) && (
                      <section className="span-2">
                        <h4>Failures</h4>
                        <ul className="failure-list">
                          {r.searchFailures.map((f, i) => (
                            <li key={`s${i}`}>
                              <StatusWord tone="bad">Search</StatusWord> <code>{f.query}</code>: {f.reason}
                            </li>
                          ))}
                          {r.fetchFailures.map((f, i) => (
                            <li key={`f${i}`}>
                              <StatusWord tone="warn">Fetch</StatusWord>{" "}
                              <a href={f.url} target="_blank" rel="noreferrer noopener">
                                {new URL(f.url).hostname.replace(/^www\./, "")}
                              </a>
                              : {f.reason}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </div>
                  <button type="button" className="link-button" onClick={() => go(`evidence?market=${market.address}`)}>
                    Inspect this market's findings
                  </button>
                </details>
              );
            })}
        </>
      )}
    </div>
  );
}
