import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError } from "./api";
import { DashboardView } from "./views/DashboardView";
import { EvidenceView } from "./views/EvidenceView";
import { MarketsView } from "./views/MarketsView";
import { ResearchView } from "./views/ResearchView";
import { SettingsView } from "./views/SettingsView";
import { SubmissionsView } from "./views/SubmissionsView";
import type { Overview, QueueItem, RunRecord, RunState, RunSummary, Settings, SubmissionRecord, Terms } from "./types";

type Route = "dashboard" | "markets" | "research" | "evidence" | "submissions" | "settings";

const NAV: { id: Route; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "markets", label: "Markets" },
  { id: "research", label: "Research" },
  { id: "evidence", label: "Evidence" },
  { id: "submissions", label: "Submissions" },
  { id: "settings", label: "Settings" },
];

function readRoute(): { route: Route; params: URLSearchParams } {
  const [path, query] = window.location.hash.replace(/^#\/?/, "").split("?");
  const route = NAV.some((n) => n.id === path) ? (path as Route) : "dashboard";

  return { route, params: new URLSearchParams(query ?? "") };
}

interface Notice {
  kind: "ok" | "error";
  text: string;
  log?: string[];
}

export function App() {
  const [location, setLocation] = useState(readRoute);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [records, setRecords] = useState<SubmissionRecord[]>([]);
  const [run, setRun] = useState<RunState | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [terms, setTerms] = useState<Terms | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const lastRunStatus = useRef<string | null>(null);

  useEffect(() => {
    const onHash = () => setLocation(readRoute());

    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (target: string) => {
    window.location.hash = `#/${target}`;
  };

  const showError = (error: unknown) => {
    const apiError = error instanceof ApiError ? error : null;

    setNotice({
      kind: "error",
      text: error instanceof Error ? error.message : String(error),
      log: apiError?.log.length ? apiError.log : undefined,
    });
  };

  const load = useCallback(async () => {
    try {
      const [o, q, h, r, rs] = await Promise.all([api.overview(), api.queue(), api.history(), api.run(), api.runs()]);

      setOverview(o);
      setQueue(q.items);
      setRecords(h.records);
      setRun(r);
      setRuns(rs.runs);
      setSelectedRun((current) => (current && rs.runs.some((x) => x.id === current) ? current : (rs.runs[0]?.id ?? null)));
      setOffline(null);
    } catch (error) {
      setOffline(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
    api.terms().then(setTerms).catch(() => setTerms(null));
    api.settings().then(setSettings).catch(() => setSettings(null));

    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!selectedRun) {
      setRecord(null);
      return;
    }

    api.runRecord(selectedRun).then(setRecord).catch(() => setRecord(null));
  }, [selectedRun]);

  // Poll quickly while a search is running; reload everything when it ends.
  useEffect(() => {
    if (run?.status !== "running") {
      if (lastRunStatus.current === "running") {
        void load();

        if (run?.status === "done") {
          setNotice({
            kind: "ok",
            text:
              run.candidatesAdded > 0
                ? `Found ${run.candidatesAdded} new note${run.candidatesAdded === 1 ? "" : "s"} to review.`
                : "The search finished without new submittable notes. The Research and Evidence views show why.",
          });
        }
      }

      lastRunStatus.current = run?.status ?? null;
      return;
    }

    lastRunStatus.current = "running";

    const timer = setInterval(() => {
      api.run().then(setRun).catch(() => {});
    }, 1500);

    return () => clearInterval(timer);
  }, [run?.status, run?.candidatesAdded, load]);

  const findEvidence = async () => {
    setNotice(null);

    try {
      await api.startRun();
      setRun(await api.run());
      go("research");
    } catch (error) {
      showError(error);
    }
  };

  const submit = async (item: QueueItem) => {
    const confirmed = window.confirm(
      `Submit this note to Delphi?\n\n${item.note}\n\n` +
        "It uses 1 of your 3 submissions on this market and can't be edited or withdrawn.",
    );

    if (!confirmed) {
      return;
    }

    setBusyId(item.id);
    setNotice(null);

    try {
      const { record: saved } = await api.submit(item.id);

      setNotice(
        saved.status === "failed"
          ? { kind: "error", text: `Delphi refused the note: ${saved.lastError ?? "no reason given"}` }
          : {
              kind: "ok",
              text:
                saved.status === "judged"
                  ? `Submitted and judged: ${saved.verdict ?? "no verdict"}${saved.bounty ? `, reward ${saved.bounty.amount}` : ""}.`
                  : `Submitted. Status: ${saved.status}. Check verdicts later.`,
            },
      );
      await load();
    } catch (error) {
      showError(error);
    } finally {
      setBusyId(null);
    }
  };

  const skip = async (item: QueueItem) => {
    setBusyId(item.id);

    try {
      await api.skip(item.id);
      await load();
    } catch (error) {
      showError(error);
    } finally {
      setBusyId(null);
    }
  };

  const refreshVerdicts = async () => {
    setRefreshing(true);

    try {
      const { updated } = await api.refreshVerdicts();

      setNotice({ kind: "ok", text: updated > 0 ? `Updated ${updated} verdict${updated === 1 ? "" : "s"}.` : "No new verdicts yet." });
      await load();
    } catch (error) {
      showError(error);
    } finally {
      setRefreshing(false);
    }
  };

  const config = overview?.config;
  const running = run?.status === "running";

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="rail" aria-label="Sections">
        <h1 className="wordmark">DelphiLens</h1>
        <p className="rail-agent">
          {config ? `Agent ${config.agentId}` : "Connecting…"}
          {running && <span className="rail-live">Searching</span>}
        </p>
        <ul>
          {NAV.map((item) => (
            <li key={item.id}>
              <a
                href={`#/${item.id}`}
                className={location.route === item.id ? "nav-link current" : "nav-link"}
                aria-current={location.route === item.id ? "page" : undefined}
              >
                {item.label}
                {item.id === "evidence" && queue.length > 0 && <span className="count">{queue.length}</span>}
              </a>
            </li>
          ))}
        </ul>
        {config && (
          <ul className="rail-health" aria-label="Setup">
            <li className={config.llmModel ? "ok" : "missing"}>{config.llmModel ?? "No LLM"}</li>
            <li className={config.hasApiClient ? "ok" : "missing"}>{config.hasApiClient ? "Delphi API connected" : "No Delphi API key"}</li>
          </ul>
        )}
      </nav>

      <main id="main" className="main">
        {notice && (
          <div className={`banner ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
            <p>{notice.text}</p>
            {notice.log && <pre className="banner-log">{notice.log.join("\n")}</pre>}
            <button type="button" className="link-button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        {!overview ? (
          <p className="empty">{offline ?? "Loading…"}</p>
        ) : (
          <>
            {location.route === "dashboard" && (
              <DashboardView
                overview={overview}
                run={run}
                runs={runs}
                records={records}
                offline={offline}
                onFindEvidence={findEvidence}
                go={go}
              />
            )}
            {location.route === "markets" && <MarketsView record={record} go={go} />}
            {location.route === "research" && (
              <ResearchView runs={runs} record={record} selected={selectedRun} onSelect={setSelectedRun} run={run} go={go} />
            )}
            {location.route === "evidence" && (
              <EvidenceView
                key={location.params.get("market") ?? "all"}
                queue={queue}
                canSubmit={Boolean(config?.hasApiClient)}
                busyId={busyId}
                onSubmit={submit}
                onSkip={skip}
                runs={runs}
                record={record}
                selected={selectedRun}
                onSelect={setSelectedRun}
                initialMarket={location.params.get("market") ?? undefined}
              />
            )}
            {location.route === "submissions" && (
              <SubmissionsView
                overview={overview}
                records={records}
                refreshing={refreshing}
                canRefresh={Boolean(config?.hasApiClient)}
                onRefresh={refreshVerdicts}
              />
            )}
            {location.route === "settings" && <SettingsView settings={settings} terms={terms} />}
          </>
        )}
      </main>
    </div>
  );
}
