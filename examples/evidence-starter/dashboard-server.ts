/**
 * Local server for the DelphiLens control panel.
 *
 *   npx tsx examples/evidence-starter/dashboard-server.ts
 *
 * Listens on 127.0.0.1 only (DASHBOARD_PORT, default 8787). Serves the API
 * and, once built (`npm run build` in dashboard/), the panel itself.
 * During development, run `npm run dev` in dashboard/ instead: Vite
 * proxies /api to this server.
 *
 * Reads the same .env as the agent. Your keys stay on this machine; the
 * browser only ever talks to localhost.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EvidenceClient } from "../../src/index.js";

import { buildSearchProvider, runMineMode, searchProviderNames } from "./agent.js";
import { DEFAULT_RUNS_DIR, loadRunRecords } from "./run-record.js";
import { createDashboardApi } from "./dashboard-api.js";
import { createLlmClientFromEnv } from "./llm-client.js";
import { ReviewQueue, DEFAULT_QUEUE_PATH } from "./review-queue.js";
import { SubmissionHistory, DEFAULT_HISTORY_PATH } from "./submission-history.js";

const env = process.env;
const port = Number(env.DASHBOARD_PORT?.trim() || 8787);
const host = "127.0.0.1";

const apiKey = env.DELPHI_API_ACCESS_KEY?.trim() || env.DELPHI_API_KEY?.trim();
const apiUrl = env.DELPHI_API_URL?.trim();
const siteUrl = env.COMPETITION_SITE_URL?.trim();
const agentId = env.AGENT_ID?.trim() || "evidence-starter";

const client =
  apiKey && apiUrl
    ? new EvidenceClient({
        baseUrl: apiUrl,
        apiKey,
        agentId,
        agentHarness: env.AGENT_HARNESS?.trim() || "gensyn-delphi-sdk/examples/evidence-starter",
        agentModel: env.AGENT_MODEL?.trim() || env.LLM_MODEL?.trim().slice(0, 64) || undefined,
      })
    : undefined;

const history = SubmissionHistory.load(env.HISTORY_PATH?.trim() || DEFAULT_HISTORY_PATH);
const queue = ReviewQueue.load(env.QUEUE_PATH?.trim() || DEFAULT_QUEUE_PATH);
/** The panel still starts with a broken LLM setting; it shows the problem instead. */
function tryCreateLlm(): ReturnType<typeof createLlmClientFromEnv> {
  try {
    return createLlmClientFromEnv();
  } catch (error) {
    console.warn(`LLM disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const llmProbe = tryCreateLlm();

const optionalInt = (name: string): number | undefined => {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : undefined;

  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
};

const runsDir = env.RUNS_DIR?.trim() || DEFAULT_RUNS_DIR;

const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/** Everything the Settings view shows. Keys and secrets are reported only as set / not set. */
const settings = {
  agent: {
    id: agentId,
    harness: env.AGENT_HARNESS?.trim() || "gensyn-delphi-sdk/examples/evidence-starter",
    modelHeader: env.AGENT_MODEL?.trim() || env.LLM_MODEL?.trim() || null,
  },
  llm: {
    configured: Boolean(llmProbe),
    model: llmProbe?.model ?? null,
    provider: hostOf(env.LLM_BASE_URL?.trim()),
    apiKey: env.LLM_API_KEY?.trim() ? "set" : "not set",
    maxCallsPerRun: optionalInt("LLM_MAX_CALLS") ?? 40,
    tokensPerMinute: optionalInt("LLM_TOKENS_PER_MINUTE") ?? 7000,
    maxCompletionTokens: optionalInt("LLM_MAX_COMPLETION_TOKENS") ?? 2048,
    reasoningEffort: env.LLM_REASONING_EFFORT?.trim() || "provider default",
    queryPlanner: env.LLM_QUERY_PLANNER?.trim() !== "0",
  },
  delphi: {
    apiUrl: hostOf(apiUrl),
    apiKey: apiKey ? "set" : "not set",
    competitionSite: hostOf(siteUrl),
    termsVersionAccepted: env.ACCEPT_TERMS?.trim() || null,
  },
  research: {
    searchProviders: searchProviderNames(),
    googleNewsEdition: `${env.GOOGLE_NEWS_HL?.trim() || "en-US"} / ${env.GOOGLE_NEWS_GL?.trim() || "US"}`,
    maxMarketsPerRun: optionalInt("MAX_MARKETS") ?? 5,
    maxArticlesFetchedPerMarket: 8,
    maxArticlesReadByLlmPerMarket: optionalInt("MAX_ARTICLES_PER_MARKET") ?? 3,
    maxFactAgeDays: 30,
  },
  submission: {
    panel: "Manual: every note needs your click and confirmation",
    commandLineMode: env.SUBMIT_MODE?.trim() || "dry-run",
    maxSubmissionsPerRun: optionalInt("MAX_SUBMISSIONS") ?? 5,
    minConfidence: Number(env.MIN_CONFIDENCE?.trim() || 0.6),
    perMarketCap: 3,
  },
  files: {
    history: env.HISTORY_PATH?.trim() || DEFAULT_HISTORY_PATH,
    queue: env.QUEUE_PATH?.trim() || DEFAULT_QUEUE_PATH,
    runs: runsDir,
  },
  server: { host, port, node: process.version },
};

const api = createDashboardApi({
  loadRuns: () => loadRunRecords(runsDir),
  settings,
  history,
  queue,
  client,
  config: {
    agentId,
    llmModel: llmProbe?.model ?? null,
    hasApiClient: Boolean(client),
    hasSiteUrl: Boolean(siteUrl),
    acceptTermsVersion: env.ACCEPT_TERMS?.trim() || undefined,
  },
  async runResearch(log) {
    const { mining } = await runMineMode({
      siteUrl: siteUrl!,
      // The panel never submits from a run: people decide per candidate.
      mode: "dry-run",
      // A fresh client per run, so each run gets the full LLM call budget.
      llm: tryCreateLlm(),
      client,
      history,
      maxMarkets: optionalInt("MAX_MARKETS"),
      maxArticlesPerMarket: optionalInt("MAX_ARTICLES_PER_MARKET"),
      useLlmQueryPlanner: env.LLM_QUERY_PLANNER?.trim() !== "0",
      researchOptions: { searchProvider: buildSearchProvider() },
      searchProviders: searchProviderNames(),
      runsDir,
      log: (...args) => log(args.map(String).join(" ")),
    });

    return mining?.candidates ?? [];
  },
});

const STATIC_ROOT = resolve(fileURLToPath(new URL("../../dashboard/dist", import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/** Blocks DNS-rebinding: only requests addressed to this machine are served. */
function isLocalHost(hostHeader: string | undefined): boolean {
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(hostHeader ?? "");
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;

    if (size > 100_000) {
      throw new Error("Request body too large");
    }

    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

function serveStatic(pathname: string, response: ServerResponse): void {
  if (!existsSync(STATIC_ROOT)) {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      "The panel is not built yet. Run `npm install` and `npm run build` in dashboard/, " +
        "or `npm run dev` there and open http://localhost:5173.",
    );
    return;
  }

  const requested = normalize(join(STATIC_ROOT, decodeURIComponent(pathname)));
  const inside = requested.startsWith(STATIC_ROOT);
  const file =
    inside && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : join(STATIC_ROOT, "index.html");

  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
  });
  response.end(readFileSync(file));
}

const server = createServer(async (request, response) => {
  try {
    if (!isLocalHost(request.headers.host)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (!url.pathname.startsWith("/api/")) {
      serveStatic(url.pathname, response);
      return;
    }

    const body = request.method === "POST" ? await readBody(request) : undefined;
    const headers = new Headers();

    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      }
    }

    const result = await api(
      new Request(url, {
        method: request.method,
        headers,
        body: body?.length ? new Uint8Array(body) : undefined,
      }),
    );

    const responseHeaders: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    response.writeHead(result.status, responseHeaders);
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(port, host, () => {
  console.log(`DelphiLens control panel: http://localhost:${port}`);
  console.log(
    `Agent ${agentId}. LLM: ${llmProbe?.model ?? "not configured"}. ` +
      `Delphi API: ${client ? "connected" : "not configured (submitting disabled)"}.`,
  );
});
