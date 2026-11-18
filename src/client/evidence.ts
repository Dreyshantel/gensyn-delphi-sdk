import { randomUUID } from "node:crypto";

// Client for the public evidence API `/v1` (specs/002-agent-competition/contracts/agent-api.md).

export type SubmissionStatus = "queued" | "judging" | "judged" | "rejected" | "failed" | "unmatched";

export interface SubmissionMarket {
  marketAddress: string;
  status: string;
  verdict: string | null;
  reason: string | null;
  bounty: { amount: string; state: "held" | "paid" | "voided" | "none" } | null;
  settlementUpTo: string | null;
  zeroPayReason?: string;
}

export interface Submission {
  id: string;
  createdAt: string;
  status: SubmissionStatus;
  code?: string;
  canRetry?: boolean;
  retryAt?: string;
  judgingEstimateSeconds?: number;
  markets: SubmissionMarket[];
}

/** List entries; the contract does not spell out the summary fields, so extra keys are allowed. */
export type SubmissionSummary = Pick<Submission, "id" | "createdAt" | "status"> & Record<string, unknown>;

export interface EntryState {
  canSubmit: boolean;
  reason?: string;
  remainingOnMarket: number;
  restricted?: boolean;
  rateLimit: { resetAt: string };
}

export interface EvidenceLimits {
  submitsLeftThisHour: number;
  hourEndsAt: string;
  dailyCapLeft: number;
  dailyCapResetAt: string;
}

export interface SubmitEvidenceParams {
  note: string;
  links?: string[];
  /** Up to 3 files. */
  files?: Blob[];
  marketAddress?: string;
  /** Sent as `Idempotency-Key`. Default: a fresh UUID. Reuse it to retry the same submit safely. */
  idempotencyKey?: string;
  /** @deprecated Ignored since 2.3.0: terms are accepted once per account with `acceptTerms`. */
  termsAccepted?: true;
}

/** `GET /terms`: the current terms for the account. `acceptedAt` is `null` until the account accepts this version. */
export interface EvidenceTerms {
  version: string;
  url: string;
  acceptedAt: string | null;
}

/** `POST /terms/acceptance`: the stored acceptance (the first one again if already accepted). */
export interface TermsAcceptance {
  version: string;
  acceptedAt: string;
}

/** Response metadata read from headers. */
export interface EvidenceMeta {
  requestId?: string;
  contractVersion?: string;
  rateLimit?: { limit: number; remaining: number; reset: number };
  /** `X-Delphi-Warnings`, e.g. `missing X-Agent-Id`. */
  warnings?: string;
  /** `Retry-After` in seconds, present while a submission is queued or judging. */
  retryAfterSeconds?: number;
  location?: string;
}

export interface EvidenceResult<T> {
  data: T;
  meta: EvidenceMeta;
}

export type EvidenceErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "terms_not_accepted"
  | "forbidden"
  | "not_found"
  | "idempotency_conflict"
  | "rate_limited"
  | "server_error";

export class EvidenceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: EvidenceErrorCode | string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null,
    readonly field: string | null,
    readonly requestId?: string,
    readonly meta: EvidenceMeta = {},
  ) {
    super(message);
    this.name = "EvidenceApiError";
  }
}

/** `403 terms_not_accepted`: the account has not accepted the current terms. Accept `terms.version` with `acceptTerms`. */
export class TermsNotAcceptedError extends EvidenceApiError {
  constructor(
    readonly terms: { version: string; url: string },
    ...args: ConstructorParameters<typeof EvidenceApiError>
  ) {
    super(...args);
    this.name = "TermsNotAcceptedError";
  }
}

export interface EvidenceClientConfig {
  /** Base URL including `/v1`, e.g. `https://<Delphi app domain>/v1`. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer`. */
  apiKey: string;
  /** Optional `X-Agent-Id`, `X-Agent-Harness`, `X-Agent-Model` (1 to 64 printable ASCII each). */
  agentId?: string;
  agentHarness?: string;
  agentModel?: string;
  /** Extra headers on every request. */
  extraHeaders?: Record<string, string>;
  /** Override for tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}

const TERMINAL: SubmissionStatus[] = ["judged", "rejected", "failed", "unmatched"];

const num = (v: string | null): number | undefined => {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export class EvidenceClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(config: EvidenceClientConfig) {
    this.base = config.baseUrl.replace(/\/+$/, "");
    this.headers = { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" };
    if (config.agentId) this.headers["X-Agent-Id"] = config.agentId;
    if (config.agentHarness) this.headers["X-Agent-Harness"] = config.agentHarness;
    if (config.agentModel) this.headers["X-Agent-Model"] = config.agentModel;
    Object.assign(this.headers, config.extraHeaders);
    this.fetchFn = config.fetch ?? ((...a) => fetch(...a));
  }

  /** `POST /submissions`. The account must have accepted the current terms, else it throws `TermsNotAcceptedError`. A 200 with `status: "rejected"` is returned as data, not thrown. */
  submitEvidence(p: SubmitEvidenceParams): Promise<EvidenceResult<Submission>> {
    const form = new FormData();
    form.append("note", p.note);
    for (const l of p.links ?? []) form.append("links[]", l);
    for (const f of p.files ?? []) form.append("files", f);
    if (p.marketAddress) form.append("marketAddress", p.marketAddress);
    return this.request("POST", "/submissions", {
      body: form,
      headers: { "Idempotency-Key": p.idempotencyKey ?? randomUUID() },
    });
  }

  getSubmission(id: string, signal?: AbortSignal): Promise<EvidenceResult<Submission>> {
    return this.request("GET", `/submissions/${encodeURIComponent(id)}`, { signal });
  }

  listSubmissions(
    q: { market?: string; cursor?: string; limit?: number } = {},
  ): Promise<EvidenceResult<{ items: SubmissionSummary[]; nextCursor: string | null }>> {
    return this.request("GET", "/submissions", { query: q });
  }

  getEntryState(market: string): Promise<EvidenceResult<EntryState>> {
    return this.request("GET", `/markets/${encodeURIComponent(market)}/entry-state`);
  }

  retrySubmission(id: string): Promise<EvidenceResult<Submission>> {
    return this.request("POST", `/submissions/${encodeURIComponent(id)}/retry`);
  }

  getLimits(): Promise<EvidenceResult<EvidenceLimits>> {
    return this.request("GET", "/limits");
  }

  getTerms(): Promise<EvidenceResult<EvidenceTerms>> {
    return this.request("GET", "/terms");
  }

  /** Accepts the terms `version` (it must be the current one) once for the account. */
  acceptTerms(version: string): Promise<EvidenceResult<TermsAcceptance>> {
    return this.request("POST", "/terms/acceptance", {
      body: JSON.stringify({ termsVersion: version }),
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Polls `getSubmission` until the status is terminal, sleeping for `Retry-After`
   * (else `defaultIntervalMs`) between calls. Throws on timeout or abort.
   */
  async waitForSubmission(
    id: string,
    opts: { timeoutMs?: number; defaultIntervalMs?: number; signal?: AbortSignal } = {},
  ): Promise<EvidenceResult<Submission>> {
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    for (;;) {
      opts.signal?.throwIfAborted();
      const res = await this.getSubmission(id, opts.signal);
      if (TERMINAL.includes(res.data.status)) return res;
      const wait = (res.meta.retryAfterSeconds ?? 0) * 1000 || (opts.defaultIntervalMs ?? 2000);
      if (Date.now() + wait > deadline) throw new Error(`Timed out waiting for submission ${id}`);
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(t); reject(opts.signal!.reason); };
        const t = setTimeout(() => { opts.signal?.removeEventListener("abort", onAbort); resolve(); }, wait);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  private async request<T>(
    method: string,
    path: string,
    o: { query?: Record<string, string | number | undefined>; body?: FormData | string; headers?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<EvidenceResult<T>> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.fetchFn(url.toString(), {
      method,
      body: o.body,
      signal: o.signal,
      headers: { ...this.headers, ...o.headers },
    });
    const h = res.headers;
    const limit = num(h.get("RateLimit-Limit"));
    const meta: EvidenceMeta = {
      requestId: h.get("X-Request-Id") ?? undefined,
      contractVersion: h.get("X-Contract-Version") ?? undefined,
      rateLimit:
        limit === undefined
          ? undefined
          : { limit, remaining: num(h.get("RateLimit-Remaining")) ?? 0, reset: num(h.get("RateLimit-Reset")) ?? 0 },
      warnings: h.get("X-Delphi-Warnings") ?? undefined,
      retryAfterSeconds: num(h.get("Retry-After")),
      location: h.get("Location") ?? undefined,
    };
    const text = await res.text();
    type Terms = { version: string; url: string };
    let json: { error?: { code?: string; message?: string; retryable?: boolean; retryAfterSeconds?: number; field?: string; terms?: Terms }; terms?: Terms; requestId?: string } | undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const e = json?.error;
      const args = [
        res.status,
        e?.code ?? "server_error",
        e?.message ?? `Evidence API request failed (${res.status}): ${text.slice(0, 200)}`,
        e?.retryable ?? res.status >= 500,
        e?.retryAfterSeconds ?? meta.retryAfterSeconds ?? null,
        e?.field ?? null,
        json?.requestId ?? meta.requestId,
        meta,
      ] as const;
      // The contract puts `terms` on the error; read it from the body root too.
      const terms = e?.terms ?? json?.terms;
      if (res.status === 403 && e?.code === "terms_not_accepted" && terms) throw new TermsNotAcceptedError(terms, ...args);
      throw new EvidenceApiError(...args);
    }
    return { data: json as T, meta };
  }
}
