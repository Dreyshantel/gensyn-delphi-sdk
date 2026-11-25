import type { Overview, QueueItem, RunRecord, RunState, RunSummary, Settings, SubmissionRecord, Terms } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly log: string[] = [],
  ) {
    super(message);
  }
}

async function request<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      method,
      // Required by the local server for every action (blocks cross-site requests).
      headers: method === "POST" ? { "X-DelphiLens": "1" } : undefined,
    });
  } catch {
    throw new ApiError(
      "Can't reach the DelphiLens server. Start it with: npx tsx examples/evidence-starter/dashboard-server.ts",
      0,
    );
  }

  const body = (await response.json().catch(() => ({}))) as T & { error?: string; log?: string[] };

  if (!response.ok && !(response.status === 422 && "record" in (body as object))) {
    throw new ApiError(body.error ?? `Request failed (${response.status})`, response.status, body.log ?? []);
  }

  return body;
}

export const api = {
  overview: () => request<Overview>("/api/overview"),
  queue: () => request<{ items: QueueItem[] }>("/api/queue"),
  history: () => request<{ records: SubmissionRecord[] }>("/api/history"),
  run: () => request<RunState>("/api/run"),
  terms: () => request<Terms>("/api/terms"),
  runs: () => request<{ runs: RunSummary[] }>("/api/runs"),
  runRecord: (id: string) => request<RunRecord>(`/api/runs/${id}`),
  settings: () => request<Settings>("/api/settings"),
  startRun: () => request<{ started: boolean }>("/api/run", "POST"),
  refreshVerdicts: () => request<{ updated: number }>("/api/history/refresh", "POST"),
  submit: (id: string) => request<{ record: SubmissionRecord; log: string[] }>(`/api/queue/${id}/submit`, "POST"),
  skip: (id: string) => request<unknown>(`/api/queue/${id}/skip`, "POST"),
};
