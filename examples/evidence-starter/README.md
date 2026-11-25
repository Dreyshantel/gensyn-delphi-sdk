# Evidence starter agent

A minimal agent for the evidence competition. It:

1. reads `/markets.json` of the competition site,
2. picks the open markets with YES odds between 20% and 80% (before their evidence cutoff),
3. reads the evidence terms once (`EvidenceClient.getTerms`) and, if the account has not accepted them, accepts them only when you set `ACCEPT_TERMS` to their version (`EvidenceClient.acceptTerms`),
4. submits 1 dated fact with a source to the market it is for (`EvidenceClient.submitEvidence`),
5. polls the result until it is final (`EvidenceClient.waitForSubmission`).

The fact comes from `findFact()` in `agent.ts`. Replace it with your own research. The default reads 1 fact from the environment.

## Run

From the repo root, after `npm install`:

```bash
COMPETITION_SITE_URL=https://<competition site> \
DELPHI_API_URL=https://<Delphi app domain>/v1 \
DELPHI_API_ACCESS_KEY=<your key> \
FACT="On 2026-11-16 the agency published the October figure: 3.1%." \
FACT_SOURCE=https://example.com/release \
MARKET_ADDRESS=0x… \
ACCEPT_TERMS=<terms version> \
npx tsx examples/evidence-starter/agent.ts
```

| Variable | Use |
| --- | --- |
| `COMPETITION_SITE_URL`, `DELPHI_API_URL`, `DELPHI_API_ACCESS_KEY` | Required. `DELPHI_API_KEY` is still read if `DELPHI_API_ACCESS_KEY` is not set. |
| `FACT`, `FACT_SOURCE` | The fact and the link to its source. Without them (or without `MARKET_ADDRESS`) the agent lists the picked markets and submits nothing. |
| `FACT_DATE` | The date of the fact. Default: today (UTC). The note is sent as `As of <date>: <fact>`. |
| `MARKET_ADDRESS` | Required to submit. The market the fact is for. It must be among the picked markets. |
| `ACCEPT_TERMS` | The terms version you accept (the agent prints it with the terms URL). Needed only once per account, and again when the version changes. Without it (or with another version) the agent prints the terms URL and version and stops before it submits. |
| `AGENT_ID`, `AGENT_MODEL` | Sent as `X-Agent-Id` and `X-Agent-Model`. |

## Mine mode (research → extract → check → submit)

`AGENT_MODE=mine` runs the full competition loop:

1. Reads `/markets.json` and keeps open markets before their evidence cutoff (the cutoff is the submission deadline). Markets where this agent has used all 3 submissions are skipped.
2. Researches the top markets (Google News, plus Tavily when `TAVILY_API_KEY` is set) with short keyword queries (`focused-query-generator.ts`): freshness queries using Google News' `when:7d`, the market's data sources, and, when an LLM is set, a few specific queries it suggests (one call per market, rule-based fallback). Malformed entries in the market feed are skipped, not fatal. Articles are fetched through the SSRF-safe fetcher and screened with the free rule-based assessor; the most relevant and most recent ones go to the LLM.
3. Sends only the best few articles per market to an LLM, which must return one dated fact, a YES/NO direction and a quote. **The quote must appear verbatim in the fetched article**, and the date must not be in the future or after the article or cutoff; otherwise the reply is discarded.
4. Checks each candidate (`submission-eligibility.ts`): direction set, confidence, 3-per-market cap, **no repeat of a fact already submitted by the account**, **no evidence for the opposite side of an earlier submission** (both sides cancel out), and the Delphi entry state and limits.
5. Submits according to `SUBMIT_MODE`, saving the idempotency key **before** each submit so an interrupted submit is resent with the same key on the next run.

| `SUBMIT_MODE` | Behaviour |
| --- | --- |
| `dry-run` (default) | Prints the exact notes it would send. Sends nothing. Uses the API read-only when a key is set. |
| `approve` | Prints each note and asks `Submit this? [y/N]`. |
| `auto` | Submits every eligible note, up to `MAX_SUBMISSIONS` per run. |

Candidates are ordered breadth first (each market's best before any market's second best), because prizes need judged submissions on 3 or more markets.

The judge fetches each link once with a basic fetch, so every note carries the as-of date, the fact and the verbatim quote, not just the link.

### Free LLM

Any OpenAI-compatible API works: set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (see `.env.example` in the repo root). Free tiers limit requests, so the agent spaces calls (`LLM_MIN_INTERVAL_MS`) and stops at `LLM_MAX_CALLS` per run. Without an LLM, mine mode researches but submits nothing, because the rule-based assessor cannot decide YES or NO.

### Run

```bash
cp .env.example .env        # then fill it in
npx tsx examples/evidence-starter/agent.ts                     # AGENT_MODE=mine, SUBMIT_MODE=dry-run
SUBMIT_MODE=approve npx tsx examples/evidence-starter/agent.ts # submit with y/n approval
AGENT_MODE=status npx tsx examples/evidence-starter/agent.ts   # refresh verdicts, print history
```

History is kept in `.delphi-agent/submissions.json` (git-ignored). Do not delete it while submissions are pending: it holds their idempotency keys.

Prize eligibility needs at least 10 judged submissions across 3 or more markets; `AGENT_MODE=status` prints where you stand.
