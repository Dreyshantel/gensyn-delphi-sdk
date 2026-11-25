import type { Settings, Terms } from "../types";
import { StatusWord } from "../ui";

const SECTION_TITLE: Record<string, string> = {
  agent: "Agent identity",
  llm: "Language model",
  delphi: "Delphi connection",
  research: "Research limits",
  submission: "Submission",
  files: "Local files",
  server: "Panel server",
};

const LABELS: Record<string, string> = {
  id: "Agent ID",
  harness: "Harness header",
  modelHeader: "Model header",
  configured: "Configured",
  model: "Model",
  provider: "Provider",
  apiKey: "API key",
  maxCallsPerRun: "Calls per run (max)",
  tokensPerMinute: "Tokens per minute (pacing)",
  maxCompletionTokens: "Output tokens per call (max)",
  reasoningEffort: "Reasoning effort",
  queryPlanner: "LLM query planner",
  apiUrl: "API host",
  competitionSite: "Competition site",
  termsVersionAccepted: "Terms version accepted (ACCEPT_TERMS)",
  searchProviders: "Search providers",
  googleNewsEdition: "Google News edition",
  maxMarketsPerRun: "Markets per run",
  maxArticlesFetchedPerMarket: "Articles fetched per market",
  maxArticlesReadByLlmPerMarket: "Articles read by the LLM per market",
  maxFactAgeDays: "Oldest fact accepted (days)",
  panel: "From this panel",
  commandLineMode: "Command-line SUBMIT_MODE",
  maxSubmissionsPerRun: "Submissions per run (max)",
  minConfidence: "Minimum model confidence",
  perMarketCap: "Submissions per market (competition rule)",
  history: "Submission history",
  queue: "Review queue",
  runs: "Run records",
  host: "Listening on",
  port: "Port",
  node: "Node.js",
};

function show(value: unknown) {
  if (value === true) return <StatusWord tone="good">Yes</StatusWord>;
  if (value === false) return <StatusWord tone="quiet">No</StatusWord>;
  if (value === "set") return <StatusWord tone="good">Set (hidden)</StatusWord>;
  if (value === "not set") return <StatusWord tone="warn">Not set</StatusWord>;
  if (value === null || value === undefined || value === "") return <span className="muted">Not set</span>;
  if (Array.isArray(value)) return value.join(", ");

  return String(value);
}

export function SettingsView({ settings, terms }: { settings: Settings | null; terms: Terms | null }) {
  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h2 className="view-title">Settings</h2>
          <p className="view-lede muted">
            Read from .env when the panel server starts. To change a setting, edit .env and restart the server. Keys are
            never shown.
          </p>
        </div>
      </header>

      {terms?.available && (
        <section className="panel">
          <h3 className="panel-title">Evidence terms</h3>
          <p>
            {terms.acceptedAt ? (
              <StatusWord tone="good">Accepted</StatusWord>
            ) : (
              <StatusWord tone="warn">Not accepted</StatusWord>
            )}{" "}
            Version {terms.version}.{" "}
            <a href={terms.url} target="_blank" rel="noreferrer noopener">
              Read the terms
            </a>
            {!terms.acceptedAt && `, then set ACCEPT_TERMS=${terms.version} in .env and restart.`}
          </p>
        </section>
      )}

      {!settings ? (
        <p className="empty">Settings are not available from the server.</p>
      ) : (
        <div className="settings-grid">
          {Object.entries(settings).map(([section, values]) => (
            <section key={section} className="panel">
              <h3 className="panel-title">{SECTION_TITLE[section] ?? section}</h3>
              <dl className="settings">
                {Object.entries(values).map(([key, value]) => (
                  <div key={key}>
                    <dt>{LABELS[key] ?? key}</dt>
                    <dd>{show(value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
