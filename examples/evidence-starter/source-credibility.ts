/**
 * Source credibility and syndication.
 *
 * Credibility here is a property of the PUBLISHER, judged from its domain.
 * It is a prior, not a verdict: a primary source can still be misread and a
 * small outlet can be right. It is used to (a) choose which articles the
 * LLM reads, (b) weight the value score, and (c) block submissions that rest
 * only on low-credibility sources.
 *
 * Tiers:
 *   primary      governments, regulators, central banks, courts, statistics
 *                offices, international bodies, official league/club sites
 *   established  wire services and established national/specialist outlets
 *   unknown      everything not listed (neutral)
 *   low          aggregators, prediction/listicle sites, user-generated
 *                platforms and re-publishers whose provenance is unclear
 */

export type CredibilityTier = "primary" | "established" | "unknown" | "low";

export const CREDIBILITY_WEIGHT: Record<CredibilityTier, number> = {
  primary: 1,
  established: 0.8,
  unknown: 0.5,
  low: 0.2,
};

const PRIMARY_SUFFIXES = [
  ".gov", ".mil", ".int", ".gov.uk", ".gov.ng", ".gov.au", ".gc.ca", ".gov.in",
  ".gouv.fr", ".bund.de", ".europa.eu", ".gov.za", ".go.jp", ".gob.mx",
];

const PRIMARY_DOMAINS = [
  "federalreserve.gov", "ecb.europa.eu", "bankofengland.co.uk", "cbn.gov.ng",
  "nigerianstat.gov.ng", "imf.org", "worldbank.org", "bis.org", "oecd.org",
  "un.org", "who.int", "sec.gov", "supremecourt.gov", "courtlistener.com",
  "premierleague.com", "uefa.com", "fifa.com", "nba.com", "nfl.com", "mlb.com",
  "formula1.com", "olympics.com", "ec.europa.eu", "congress.gov", "whitehouse.gov",
  "inecnigeria.org", "fec.gov", "bls.gov", "bea.gov", "census.gov", "treasury.gov",
  "eia.gov", "noaa.gov", "nasa.gov", "cmegroup.com", "nasdaq.com", "nyse.com",
  "prnewswire.com", "globenewswire.com", "businesswire.com",
];

const ESTABLISHED_DOMAINS = [
  "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com", "nytimes.com",
  "washingtonpost.com", "bbc.com", "bbc.co.uk", "theguardian.com", "economist.com",
  "cnbc.com", "cnn.com", "nbcnews.com", "abcnews.com", "abcnews.go.com", "cbsnews.com",
  "foxbusiness.com", "foxnews.com", "axios.com", "politico.com", "aljazeera.com",
  "npr.org", "pbs.org", "latimes.com", "usatoday.com", "theatlantic.com", "time.com",
  "fortune.com", "forbes.com", "businessinsider.com", "marketwatch.com", "barrons.com",
  "nikkei.com", "scmp.com", "dw.com", "france24.com", "lemonde.fr", "spiegel.de",
  "espn.com", "skysports.com", "theathletic.com", "nbcsports.com", "goal.com",
  "coindesk.com", "theblock.co", "decrypt.co", "cointelegraph.com", "dlnews.com",
  "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com",
  "premiumtimesng.com", "punchng.com", "vanguardngr.com", "thecable.ng",
  "channelstv.com", "businessday.ng", "guardian.ng", "nairametrics.com",
  "thisdaylive.com", "dailytrust.com", "arise.tv", "tvcnews.tv", "africa.businessinsider.com",
  "semafor.com", "theinformation.com", "statnews.com", "nature.com", "science.org",
];

const LOW_DOMAINS = [
  "247wallst.com", "coinpedia.org", "finance.biggo.com", "biggo.com", "newscord.org",
  "beincrypto.com", "u.today", "coingape.com", "cryptopolitan.com", "zycrypto.com",
  "medium.com", "substack.com", "blogspot.com", "wordpress.com", "reddit.com",
  "quora.com", "x.com", "twitter.com", "facebook.com", "tiktok.com", "youtube.com",
  "msn.com", "newsbreak.com", "ground.news", "inkl.com", "journalarta.com",
  "investinglive.com", "fxstreet.com", "benzinga.com", "ccn.com", "dailyhodl.com",
  "phemex.com", "binance.com", "bitget.com", "mexc.com",
];

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function credibilityTier(url: string): CredibilityTier {
  const host = hostnameOf(url);

  if (!host) {
    return "low";
  }

  if (
    PRIMARY_DOMAINS.some((d) => matchesDomain(host, d)) ||
    PRIMARY_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return "primary";
  }

  if (LOW_DOMAINS.some((d) => matchesDomain(host, d))) {
    return "low";
  }

  if (ESTABLISHED_DOMAINS.some((d) => matchesDomain(host, d))) {
    return "established";
  }

  return "unknown";
}

/** Normalises a headline for syndication comparison. */
function headlineTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/\s+[-|–—]\s+[^-|–—]+$/, "") // trailing " - Publisher"
      .split(/[^a-z0-9%.]+/)
      .filter((token) => token.length > 2),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const token of a) {
    if (b.has(token)) {
      shared++;
    }
  }

  return shared / Math.min(a.size, b.size);
}

export interface SyndicationItem {
  key: string;
  title: string;
  content: string;
}

/**
 * Groups items that are copies of the same report: near-identical headlines,
 * or bodies whose opening 400 characters match. Returns groups of keys;
 * the caller keeps one item per group (the most credible) and records the
 * rest as syndicated copies, which are NOT independent corroboration.
 */
export function groupSyndicated(items: SyndicationItem[], threshold = 0.8): string[][] {
  const groups: { keys: string[]; tokens: Set<string>; opening: string }[] = [];

  for (const item of items) {
    const tokens = headlineTokens(item.title);
    const opening = item.content.replace(/\s+/g, " ").trim().slice(0, 400).toLowerCase();

    const match = groups.find(
      (group) =>
        overlap(group.tokens, tokens) >= threshold ||
        (opening.length >= 200 && opening === group.opening),
    );

    if (match) {
      match.keys.push(item.key);
    } else {
      groups.push({ keys: [item.key], tokens, opening });
    }
  }

  return groups.map((group) => group.keys);
}
