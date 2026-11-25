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

## Control panel (DelphiLens dashboard)

A local React app with six views: **Dashboard** (status, the run's evidence funnel, submissions, prize progress, warnings, activity), **Markets** (questions, probabilities, criteria, the structured market reading, research status), **Research** (queries, providers, fetch results and failures per market), **Evidence** (notes waiting for your Submit or Skip, then every assessed article with its direction, relationship, credibility, dates, scores, reasons and limitations), **Submissions** (statuses, IDs, judge feedback, rewards) and **Settings** (configuration and health; keys are never shown).

```bash
# Terminal 1, repo root: the local API (reads the same .env as the agent)
npx tsx examples/evidence-starter/dashboard-server.ts

# Terminal 2: the panel, with live reload
cd dashboard
npm install
npm run dev            # open http://localhost:5173
```

Or build it once (`npm run build` in `dashboard/`) and open http://localhost:8787, served by the API server itself.

- Searches from the panel are always dry runs; a note is only sent when you click **Submit note** and confirm. Each submit re-runs every eligibility check against Delphi's live limits first.
- The server listens on 127.0.0.1 only, rejects requests not addressed to localhost, and requires an `X-DelphiLens` header on every action, so other websites can't submit through it.
- Terms are never accepted from the panel: set `ACCEPT_TERMS` in `.env` after reading them.
- Candidates wait in `.delphi-agent/review-queue.json`, next to the submission history.

## How evidence is assessed and ranked

**Classification.** The LLM reads one article at a time (the most relevant ~6,000 characters; the quote is still checked against the whole article) and must classify it as `direct_support` (a dated fact that makes YES more likely), `contradiction` (same, for NO), `context`, `inconclusive` or `irrelevant`. A YES/NO direction exists only for the first two. A reply whose relationship and direction disagree is rejected; a direction on context or inconclusive evidence is discarded, never forced.

**Grounding checks** (`fact-extractor.ts`). A directional finding needs a quote found verbatim in the fetched article and an as-of (event) date that is not in the future, not after the article's publication and not after the market cutoff. Passing proves the text is in the source, not that the source is right.

**Event dates come from the article.** A directional finding also needs a `dateQuote`: verbatim article text that states the event date ("on Nov. 18", "released 20 November 2026"), whose month and day must match the as-of date. Relative words ("on Tuesday", "yesterday") count only when the page itself states its publication date. A publication date that came only from a search listing (it can be the date an old page was re-indexed) is never used to date an event, to judge freshness or in the note. This rejects old pages re-listed as new.

**Unrated outlets need a stronger source** (`primary-source.ts`). When the only source for a fact is an unrated outlet, the agent looks for the same fact at a primary or established source: first among the market's fetched articles, then with one targeted search (up to two pages fetched, no LLM call). It must repeat the fact's numbers and most of its key terms. A confirmed fact is submitted with both links and the note names the confirming source; an unconfirmed one is held as "needs primary source".

**Before the LLM** (`evidence-miner.ts`). Syndicated copies of the same report are grouped and only the most credible copy is read (copies are not independent corroboration). Articles are chosen by `0.5 × keyword relevance + 0.25 × publisher credibility + 0.25 × freshness`, never by keywords alone.

**Publisher credibility** (`source-credibility.ts`) is a prior from the domain: primary (governments, regulators, central banks, courts, statistics offices, official league sites) 1.0, established outlets 0.8, unrated 0.5, low-credibility aggregators and user-generated sites 0.2. A finding that rests only on a low-credibility source cannot be submitted.

**Value score** (orders candidates; it is not a gate and not verification):

| Part | Weight | Measures |
| --- | --- | --- |
| Impact | 0.30 | the model's confidence that the fact moves the outcome |
| Credibility | 0.20 | publisher tier |
| Freshness | 0.20 | age of the fact's event date (≤3 days 1.0 … >30 days 0.2) |
| Specificity | 0.15 | numbers, dated months and names in the fact |
| Keyword relevance | 0.15 | rule-based relevance of the article |

**Gates** (`submission-eligibility.ts`): direction established, relationship directional, not low-credibility, confidence ≥ `MIN_CONFIDENCE`, fact ≤ 30 days old, quote present, market open and before the cutoff, ≤ 3 per market, no opposite-side submission on the market, not a repeat of a fact already submitted by the account, within Delphi's limits.

**Feedback loop.** Judge reasons on rejected or unpaid submissions (this market's first) are passed to the LLM on later runs so it avoids repeating them.

**Run records.** Every run writes `.delphi-agent/runs/<time>.json`: markets, the structured market reading, queries, fetch failures, every article's outcome and reasons, and metrics (fetch success, candidate rate, invented quotes caught, duplicate rate, credibility mix, LLM calls and tokens, duration). The control panel's Markets, Research and Evidence views read these.

**Live check.** `npx tsx examples/evidence-starter/live-check.ts` runs this whole pipeline in dry-run on four representative markets with a throwaway history, prints the evaluation and saves a run record.
