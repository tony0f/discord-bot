const tp = require("./threepo");

const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Gamma umaResolutionStatus values that mean a LIVE proposal exists.
// "challenged"/"disputed" are deliberately NOT here: a disputed proposal is
// knocked out and the market needs a fresh proposal — prime request material.
const PROPOSED_STATUSES = new Set(["proposed", "reproposed"]);

const TIE_OUTCOME = "50-50";

async function gammaGet(path) {
  const res = await fetch(`${GAMMA_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Gamma API error ${res.status} for ${path}`);
  }
  return res.json();
}

async function fetchMarketBySlug(slug) {
  // Gamma excludes closed markets by default, so a market "disappears" from
  // the plain slug lookup the moment it resolves. Retry with closed=true —
  // essential for the watcher to detect settlements.
  const data = await gammaGet(`/markets?slug=${encodeURIComponent(slug)}`);
  if (Array.isArray(data) && data.length > 0) return data[0];
  const closedData = await gammaGet(
    `/markets?slug=${encodeURIComponent(slug)}&closed=true`,
  );
  return Array.isArray(closedData) && closedData.length > 0 ? closedData[0] : null;
}

// Bulk-fetch full market objects for many slugs in few calls. Gamma accepts
// repeated slug params but silently drops closed markets from the default
// view, so missing ones are retried with closed=true.
async function fetchMarketsBySlugs(slugs) {
  if (!slugs || slugs.length === 0) return [];
  const bySlug = new Map();
  for (let i = 0; i < slugs.length; i += 20) {
    const chunk = slugs.slice(i, i + 20);
    const qs = chunk.map((s) => `slug=${encodeURIComponent(s)}`).join("&");
    const open = await gammaGet(`/markets?${qs}&limit=100`);
    for (const m of open) bySlug.set(m.slug, m);
    const missing = chunk.filter((s) => !bySlug.has(s));
    if (missing.length > 0) {
      const qsClosed = missing.map((s) => `slug=${encodeURIComponent(s)}`).join("&");
      const closed = await gammaGet(`/markets?${qsClosed}&closed=true&limit=100`);
      for (const m of closed) bySlug.set(m.slug, m);
    }
  }
  return slugs.map((s) => bySlug.get(s)).filter(Boolean);
}

async function fetchEventBySlug(slug) {
  const data = await gammaGet(`/events?slug=${encodeURIComponent(slug)}`);
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// Accepts polymarket.com and predict.fun URLs. Returns slug candidates for
// the 3PO search: a URL segment may name a market, an event, or both, so the
// last path segment is tried as either unless the path is explicit.
function parseMarketUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const isPolymarket = /(^|\.)polymarket\.com$/i.test(url.hostname);
  const isPredictFun = /(^|\.)predict\.fun$/i.test(url.hostname);
  if (!isPolymarket && !isPredictFun) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 1) return null;

  if (isPolymarket) {
    if (segments.length < 2) return null;
    const kind = segments[0].toLowerCase();
    if (kind === "market") {
      return { marketSlug: segments[1], eventSlug: null };
    }
    if (kind === "event" && segments[2]) {
      return { marketSlug: segments[2], eventSlug: segments[1] };
    }
    if (kind === "event") {
      return { marketSlug: segments[1], eventSlug: segments[1] };
    }
  }
  // predict.fun paths and Polymarket category paths (/esports/..., /sports/...):
  // the last segment is the candidate for both filters
  const last = segments[segments.length - 1];
  return { marketSlug: last, eventSlug: last };
}

// Normalized market shape used across the request flows, built from 3PO items
function normalizeItem(item) {
  return {
    slug: item.market_slug,
    title: item.title,
    question: item.title,
    conditionId: item.condition_id,
    questionId: item.question_id,
    status: item.status,
    creationSource: item.creation_source || "polymarket",
    endTime: item.end_time || null,
  };
}

// Outcome names for a 3PO item. Polymarket markets get their real outcomes
// from Gamma (team names, Over/Under...); Predict.fun markets are binary.
async function outcomesForItem(item) {
  const source = item.creation_source || item.creationSource;
  const slug = item.market_slug || item.slug;
  if (source === "polymarket") {
    try {
      const gammaMarket = await fetchMarketBySlug(slug);
      const outcomes = gammaMarket ? getOutcomes(gammaMarket) : [];
      if (outcomes.length > 0) {
        return { outcomes, groupTitle: gammaMarket.groupItemTitle || null };
      }
    } catch (err) {
      console.warn(`[PM] Gamma outcome lookup failed for ${slug}:`, err.message);
    }
  }
  return { outcomes: ["Yes", "No"], groupTitle: null };
}

// Resolves a user-shared URL (polymarket.com or predict.fun) into form data
// via the 3PO search API, which matches both market and event slugs.
async function resolveLinkForForm(rawUrl) {
  const parsed = parseMarketUrl(rawUrl);
  if (!parsed) {
    return {
      error:
        "That does not look like a valid link. Paste a market or event URL from polymarket.com or predict.fun.",
    };
  }

  // 3PO ANDs its filters, so market/event slugs must be tried separately.
  // When the same segment could be either (shared series slugs, category or
  // predict.fun paths), the event goes first so every bracket surfaces.
  const sameSlug = parsed.marketSlug && parsed.marketSlug === parsed.eventSlug;
  const lookups = sameSlug
    ? [{ eventSlug: parsed.eventSlug }, { marketSlug: parsed.marketSlug }]
    : [
        ...(parsed.marketSlug ? [{ marketSlug: parsed.marketSlug }] : []),
        ...(parsed.eventSlug ? [{ eventSlug: parsed.eventSlug }] : []),
      ];

  let items = [];
  for (const lookup of lookups) {
    items = await tp.searchMarkets(lookup);
    if (items.length > 0) break;
  }
  if (items.length === 0) {
    return { error: "Market not found. Please check the link." };
  }

  const requestable = items.filter((i) => tp.isRequestable(i.status));
  if (requestable.length === 0) {
    return {
      error:
        "Every market for that link already has a live proposal or is settled — nothing left to request.",
    };
  }

  if (requestable.length === 1) {
    const market = normalizeItem(requestable[0]);
    market.outcomes = (await outcomesForItem(requestable[0])).outcomes;
    return { type: "market", market };
  }

  return {
    type: "event",
    eventTitle: requestable[0].event_slug || parsed.eventSlug || "event",
    brackets: requestable.map(normalizeItem),
  };
}

function parseJsonArrayField(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getOutcomes(market) {
  return parseJsonArrayField(market.outcomes);
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Matches free-text user input against the market's outcomes.
// Supports p1/p2/p3 shorthand for binary Yes/No markets and 50-50/tie.
// Returns the canonical outcome string, TIE_OUTCOME, or null.
function matchOutcome(input, outcomes) {
  const norm = normalize(input);
  if (!norm) return null;

  if (["50 50", "p3", "tie", "50", "5050"].includes(norm)) {
    return TIE_OUTCOME;
  }

  const normalizedOutcomes = outcomes.map(normalize);
  const isBinaryYesNo =
    normalizedOutcomes.length === 2 &&
    normalizedOutcomes.includes("yes") &&
    normalizedOutcomes.includes("no");

  if (isBinaryYesNo) {
    // UMA convention for YES_OR_NO_QUERY: p1 = No, p2 = Yes
    if (norm === "p1" || norm === "p1 no") return outcomes[normalizedOutcomes.indexOf("no")];
    if (norm === "p2" || norm === "p2 yes") return outcomes[normalizedOutcomes.indexOf("yes")];
  }

  // Exact match
  const exactIdx = normalizedOutcomes.indexOf(norm);
  if (exactIdx !== -1) return outcomes[exactIdx];

  // Unique partial match (e.g. "norway" for outcome "Norway")
  const partialMatches = normalizedOutcomes
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.includes(norm) || norm.includes(o));
  if (partialMatches.length === 1) return outcomes[partialMatches[0].i];

  return null;
}

function hasProposal(market) {
  return PROPOSED_STATUSES.has((market.umaResolutionStatus || "").toLowerCase());
}

function isResolved(market) {
  return (market.umaResolutionStatus || "").toLowerCase() === "resolved";
}

// After resolution, outcomePrices snap to "1"/"0" (or "0.5"/"0.5" for a tie).
// Returns the winning outcome string, TIE_OUTCOME, or null if indeterminate.
function getWinningOutcome(market) {
  const outcomes = getOutcomes(market);
  const prices = parseJsonArrayField(market.outcomePrices).map(Number);
  if (outcomes.length === 0 || prices.length !== outcomes.length) return null;

  const winnerIdx = prices.findIndex((p) => p >= 0.99);
  if (winnerIdx !== -1) return outcomes[winnerIdx];

  if (prices.every((p) => Math.abs(p - 0.5) < 0.01)) return TIE_OUTCOME;

  return null;
}

// A market is an "early claim" if its scheduled end/game time is still in the
// future. Legit early-resolution requests are allowed but flagged so
// proposers know to demand strong evidence. The credit window is the real
// protection against too-early (P4) farming: if no whitelisted proposer acts
// within the window, the request expires with no credit.
function isEarlyClaim(market, now = Date.now()) {
  const candidates = [market.gameStartTime, market.endDate]
    .map((d) => (d ? new Date(d).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  if (candidates.length === 0) return false;
  return Math.max(...candidates) > now;
}

module.exports = {
  TIE_OUTCOME,
  resolveLinkForForm,
  outcomesForItem,
  fetchMarketBySlug,
  fetchMarketsBySlugs,
  getOutcomes,
  matchOutcome,
  hasProposal,
  isResolved,
  getWinningOutcome,
  isEarlyClaim,
};
