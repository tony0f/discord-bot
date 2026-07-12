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

// Accepts /event/<event>[/<market>], /market/<market>, and category paths
// like /esports/cs2/<league>/<slug> or /sports/... where the last segment
// is a slug that may name an event, a market, or both (Polymarket reuses
// the same slug for a series event and its moneyline market).
function parsePolymarketUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)polymarket\.com$/i.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const kind = segments[0].toLowerCase();
  if (kind === "market") {
    return { marketSlug: segments[1], eventSlug: null, preferEvent: false };
  }
  if (kind === "event") {
    return {
      marketSlug: segments[2] || null,
      eventSlug: segments[1],
      preferEvent: !segments[2],
    };
  }
  // Category path: the last segment is the slug candidate. Prefer the event
  // so shared event/market slugs surface every bracket, not just moneyline.
  const last = segments[segments.length - 1];
  return { marketSlug: last, eventSlug: last, preferEvent: true };
}

// Resolves a user-provided URL to a single Gamma market object.
// Returns { market } on success or { error } with a user-facing message.
async function resolveMarketFromUrl(rawUrl) {
  const parsed = parsePolymarketUrl(rawUrl);
  if (!parsed) {
    return {
      error:
        "That does not look like a valid Polymarket link. Expected `https://polymarket.com/event/...` or `https://polymarket.com/market/...`.",
    };
  }

  // Most specific first: an explicit market slug
  if (parsed.marketSlug) {
    const market = await fetchMarketBySlug(parsed.marketSlug);
    if (market) return { market };
  }

  // Fall back to the event: only unambiguous if it has exactly one market
  if (parsed.eventSlug) {
    const event = await fetchEventBySlug(parsed.eventSlug);
    if (event && Array.isArray(event.markets)) {
      const openMarkets = event.markets.filter((m) => !m.closed);
      const candidates = openMarkets.length > 0 ? openMarkets : event.markets;
      if (candidates.length === 1) {
        // The event endpoint returns slim market objects; re-fetch the full one
        const market = await fetchMarketBySlug(candidates[0].slug);
        if (market) return { market };
      }
      if (candidates.length > 1) {
        return {
          error:
            `That event contains **${candidates.length} markets**. Please open the specific market on Polymarket and paste its direct link.`,
        };
      }
    }
  }

  return { error: "Market not found on Polymarket. Please check the link." };
}

// Resolves a user-provided URL into data for the dynamic /request form.
// Returns one of:
//   { type: "market", market }                      — a single concrete market
//   { type: "event", eventTitle, brackets: [...] }  — event with selectable brackets
//   { error }                                       — user-facing message
async function resolveLinkForForm(rawUrl) {
  const parsed = parsePolymarketUrl(rawUrl);
  if (!parsed) {
    return {
      error:
        "That does not look like a valid Polymarket link. Paste the URL of a market or event on polymarket.com.",
    };
  }

  const tryMarket = async () => {
    if (!parsed.marketSlug) return null;
    const market = await fetchMarketBySlug(parsed.marketSlug);
    return market ? { type: "market", market } : null;
  };

  const tryEvent = async () => {
    if (!parsed.eventSlug) return null;
    const event = await fetchEventBySlug(parsed.eventSlug);
    if (!event || !Array.isArray(event.markets) || event.markets.length === 0) {
      return null;
    }
    const requestable = event.markets.filter(
      (m) => !m.closed && !hasProposal(m) && !isResolved(m),
    );
    if (requestable.length === 0) {
      return {
        error:
          "Every market in that event is already closed, proposed, or resolved — nothing left to request.",
      };
    }
    if (requestable.length === 1) {
      const market = await fetchMarketBySlug(requestable[0].slug);
      if (market) return { type: "market", market };
    }
    return {
      type: "event",
      eventTitle: event.title || parsed.eventSlug,
      brackets: requestable.map((m) => ({
        slug: m.slug,
        title: m.groupItemTitle || m.question,
        question: m.question,
        conditionId: m.conditionId || null,
      })),
    };
  };

  // Shared event/market slugs must surface the whole event (all brackets),
  // not silently lock onto the moneyline market — hence preferEvent.
  const lookups = parsed.preferEvent ? [tryEvent, tryMarket] : [tryMarket, tryEvent];
  for (const lookup of lookups) {
    const result = await lookup();
    if (result) return result;
  }

  return { error: "Market not found on Polymarket. Please check the link." };
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
  resolveMarketFromUrl,
  resolveLinkForForm,
  fetchMarketBySlug,
  fetchMarketsBySlugs,
  getOutcomes,
  matchOutcome,
  hasProposal,
  isResolved,
  getWinningOutcome,
  isEarlyClaim,
};
