// Client for 3PO — UMA's market data API (https://api.3po.dev).
// Replaces Gamma for market STATE (statuses, proposal lifecycle, settlement):
// unlike Gamma it exposes the proposed outcome per request cycle and covers
// both Polymarket and Predict.fun markets (creation_source).
const BASE = "https://api.3po.dev";
const TOKEN = process.env.THREEPO_API_TOKEN || "";

const TIE_OUTCOME = "50-50";

async function get(path) {
  const headers = { Accept: "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`3PO API error ${res.status} for ${path}`);
  return res.json();
}

// Search by exact slugs. A user-shared URL segment may be a market slug OR an
// event slug, so both filters are tried (3PO ORs across provided filters).
async function searchMarkets({ marketSlug, eventSlug, questionIds } = {}) {
  const params = new URLSearchParams({ page_size: "100" });
  if (marketSlug) params.set("market_slugs", marketSlug);
  if (eventSlug) params.set("event_slugs", eventSlug);
  if (questionIds?.length) params.set("question_ids", questionIds.join(","));
  const data = await get(`/search?${params}`);
  return Array.isArray(data.items) ? data.items : [];
}

// Full market payload including resolution.request_lifecycle
async function getMarket(identifier) {
  return get(`/market/${encodeURIComponent(identifier)}`);
}

// ---- Status semantics ----
// live            → no live proposal, requestable
// proposed        → live proposal on-chain (blocks new requests)
// extended_review → proposal knocked into review; treated like disputed
// disputed        → proposal knocked out; a fresh proposal is needed → requestable
// settled         → resolved
function hasLiveProposal(status) {
  return status === "proposed";
}
function isSettled(status) {
  return status === "settled";
}
function isRequestable(status) {
  return ["live", "disputed", "extended_review"].includes(status);
}

// Maps a p-value ("p1"/"p2"/"p3") or scaled value to a human outcome label.
// Binary Polymarket/Predict.fun markets follow the YES_OR_NO convention:
// p1 = No, p2 = Yes, p3 = 50-50. `decoded` (when 3PO provides it, e.g. team
// names) always wins.
function outcomeLabel({ pValue, decoded, valueScaled }) {
  if (decoded) return decoded;
  const p =
    pValue ||
    (valueScaled === 1000000000000000000 || valueScaled === "1000000000000000000"
      ? "p2"
      : valueScaled === 0 || valueScaled === "0"
        ? "p1"
        : valueScaled === 500000000000000000 || valueScaled === "500000000000000000"
          ? "p3"
          : null);
  if (p === "p1") return "No";
  if (p === "p2") return "Yes";
  if (p === "p3") return TIE_OUTCOME;
  return null;
}

// Extracts the current on-chain proposal (latest lifecycle cycle) and the
// final outcome, as human labels, from a /market payload.
function extractResolution(market) {
  const resolution = market.resolution || {};
  const cycles = resolution.request_lifecycle || [];
  const latest = cycles.length > 0 ? cycles[cycles.length - 1] : null;

  const proposedOutcome = latest
    ? outcomeLabel({
        pValue: latest.proposed_outcome,
        decoded: latest.proposed_outcome_decoded,
        valueScaled: latest.proposed_outcome_value_scaled,
      })
    : null;

  const settledOutcome = outcomeLabel({
    pValue: resolution.outcome,
    decoded: resolution.outcome_decoded,
    valueScaled: resolution.outcome_value_scaled,
  });

  return {
    status: resolution.status || null,
    settled: !!resolution.settled,
    proposedOutcome,
    settledOutcome,
    explorerLink: resolution.oracle_explorer_link || null,
  };
}

module.exports = {
  TIE_OUTCOME,
  searchMarkets,
  getMarket,
  hasLiveProposal,
  isSettled,
  isRequestable,
  outcomeLabel,
  extractResolution,
};
