const db = require("./db");
const pm = require("./polymarket");
const { QUALIFY_MIN_SETTLED, QUALIFY_MIN_ACCURACY } = require("./config");

const ACTIVE_STATUSES = ["pending", "proposed"];

function intSetting(settings, key) {
  const n = parseInt(settings[key], 10);
  return Number.isNaN(n) ? 0 : n;
}

async function getUserStats(userId) {
  const res = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('pending','proposed')) AS active,
       COUNT(*) FILTER (WHERE status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE status = 'proposed') AS proposed,
       COUNT(*) FILTER (WHERE status = 'expired') AS expired,
       COUNT(*) FILTER (WHERE status = 'settled_correct'
         AND settled_at > now() - interval '6 months') AS correct_6m,
       COUNT(*) FILTER (WHERE status = 'settled_incorrect'
         AND settled_at > now() - interval '6 months') AS incorrect_6m,
       COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours'
         AND status <> 'invalidated') AS last_24h,
       COUNT(*) AS total
     FROM proposal_requests
     WHERE discord_user_id = $1`,
    [userId],
  );
  const r = res.rows[0];
  const stats = {
    active: Number(r.active),
    pending: Number(r.pending),
    proposed: Number(r.proposed),
    expired: Number(r.expired),
    correct6m: Number(r.correct_6m),
    incorrect6m: Number(r.incorrect_6m),
    last24h: Number(r.last_24h),
    total: Number(r.total),
  };
  stats.settled6m = stats.correct6m + stats.incorrect6m;
  stats.accuracy6m =
    stats.settled6m > 0 ? stats.correct6m / stats.settled6m : null;
  stats.qualified =
    stats.settled6m >= QUALIFY_MIN_SETTLED &&
    stats.accuracy6m !== null &&
    stats.accuracy6m >= QUALIFY_MIN_ACCURACY;
  return stats;
}

// Full validation pipeline for a new request. Returns:
//   { ok: true, request, market } — created and stored
//   { ok: false, error }         — user-facing rejection message
// The market is re-fetched fresh by slug: state may have changed between the
// moment the form was shown and the moment it was submitted.
async function createRequest({ user, displayName, marketSlug, outcomeInput, evidence }) {
  const settings = await db.getSettings();

  // Evidence is optional: proving a negative (e.g. "No — the event never
  // happened") often has no link to point at.

  // 1. User-level gates
  const stats = await getUserStats(user.id);
  if (stats.qualified) {
    return {
      ok: false,
      error:
        `🎓 You completed your record: **${stats.settled6m} settled requests** with **${(stats.accuracy6m * 100).toFixed(1)}% accuracy** in the last 6 months. ` +
        `New requests are closed for your account.`,
    };
  }
  const maxActive = intSetting(settings, "max_active_per_user");
  if (stats.active >= maxActive) {
    return {
      ok: false,
      error: `You already have **${stats.active} active requests** (max ${maxActive}). Wait until some of them are proposed or expire.`,
    };
  }
  const dailyLimit = intSetting(settings, "daily_request_limit");
  if (stats.last24h >= dailyLimit) {
    return {
      ok: false,
      error: `You reached the limit of **${dailyLimit} requests per 24h**. Try again later.`,
    };
  }

  // 2. Fetch the market fresh from Polymarket
  let market;
  try {
    market = await pm.fetchMarketBySlug(marketSlug);
  } catch (err) {
    console.error("[PR] Gamma API error:", err.message);
    return {
      ok: false,
      error: "Could not reach the Polymarket API right now. Please try again in a few minutes.",
    };
  }
  if (!market) {
    return { ok: false, error: "Market not found on Polymarket. Please check the link." };
  }

  // 3. Market-state gates
  if (pm.isResolved(market) || market.closed) {
    return {
      ok: false,
      error: `**${market.question}** is already resolved/closed. Nothing to request here.`,
    };
  }
  if (pm.hasProposal(market)) {
    return {
      ok: false,
      error: `**${market.question}** already has an on-chain proposal (status: \`${market.umaResolutionStatus}\`). Requests must arrive **before** the proposal to count as signal.`,
    };
  }

  // 4. Outcome matching
  const outcomes = pm.getOutcomes(market);
  const matchedOutcome = pm.matchOutcome(outcomeInput, outcomes);
  if (!matchedOutcome) {
    return {
      ok: false,
      error:
        `Could not match your outcome \`${outcomeInput}\` to this market.\n` +
        `Valid outcomes: ${outcomes.map((o) => `\`${o}\``).join(", ")} (or \`50-50\`).`,
    };
  }

  // 5. Dedupe (friendly pre-check; the partial unique index is the real guard)
  const dupe = await db.query(
    `SELECT id, discord_username FROM proposal_requests
     WHERE condition_id = $1 AND status = ANY($2)
     LIMIT 1`,
    [market.conditionId, ACTIVE_STATUSES],
  );
  if (dupe.rows.length > 0) {
    return {
      ok: false,
      error: `This market was already requested by **${dupe.rows[0].discord_username}** (request #${dupe.rows[0].id}). Only the first requester gets the credit.`,
    };
  }

  const earlyClaim = pm.isEarlyClaim(market);

  // 6. Insert
  try {
    const insert = await db.query(
      `INSERT INTO proposal_requests
        (discord_user_id, discord_username, discord_display_name, wallet_address,
         market_slug, market_question, condition_id, question_id, market_url,
         outcomes, requested_outcome, evidence, end_date, early_claim)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        user.id,
        user.username,
        displayName || user.username,
        null,
        market.slug,
        market.question,
        market.conditionId,
        market.questionID || null,
        `https://polymarket.com/market/${market.slug}`,
        JSON.stringify(outcomes),
        matchedOutcome,
        evidence || "",
        market.endDate ? new Date(market.endDate) : null,
        earlyClaim,
      ],
    );
    return { ok: true, request: insert.rows[0], market };
  } catch (err) {
    if (err.code === "23505") {
      // unique_violation on the partial index — someone won the race
      return {
        ok: false,
        error: "Someone else requested this market a moment before you. Only the first requester gets the credit.",
      };
    }
    throw err;
  }
}

async function setRequestMessage(id, channelId, messageId) {
  await db.query(
    `UPDATE proposal_requests SET channel_id = $2, message_id = $3, updated_at = now() WHERE id = $1`,
    [id, channelId, messageId],
  );
}

async function getLeaderboard(limit = 15) {
  const res = await db.query(
    `SELECT discord_user_id,
            MAX(discord_username) AS username,
            COUNT(*) FILTER (WHERE status = 'settled_correct') AS correct,
            COUNT(*) FILTER (WHERE status = 'settled_incorrect') AS incorrect
     FROM proposal_requests
     WHERE status IN ('settled_correct','settled_incorrect')
       AND settled_at > now() - interval '6 months'
     GROUP BY discord_user_id
     ORDER BY COUNT(*) FILTER (WHERE status = 'settled_correct') DESC,
              COUNT(*) FILTER (WHERE status = 'settled_incorrect') ASC
     LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => {
    const correct = Number(r.correct);
    const incorrect = Number(r.incorrect);
    const settled = correct + incorrect;
    return {
      userId: r.discord_user_id,
      username: r.username,
      correct,
      incorrect,
      settled,
      accuracy: settled > 0 ? correct / settled : 0,
    };
  });
}

async function listActiveRequests() {
  const res = await db.query(
    `SELECT * FROM proposal_requests
     WHERE status IN ('pending','proposed')
     ORDER BY created_at ASC`,
  );
  return res.rows;
}

async function getRequestById(id) {
  const res = await db.query(`SELECT * FROM proposal_requests WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function updateRequestStatus(id, fields) {
  const sets = ["updated_at = now()"];
  const params = [id];
  let i = 2;
  for (const [col, val] of Object.entries(fields)) {
    sets.push(`${col} = $${i}`);
    params.push(val);
    i++;
  }
  const res = await db.query(
    `UPDATE proposal_requests SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
    params,
  );
  return res.rows[0] || null;
}

async function invalidateRequest(id, reason) {
  return updateRequestStatus(id, { status: "invalidated", invalidated_reason: reason });
}

// Community warnings: any user can flag an active request they believe is
// bad-faith. Many warnings per request, at most one per reporter.
async function reportRequest(id, reporter, reason) {
  const request = await getRequestById(id);
  if (!request) {
    return { ok: false, error: `Request #${id} not found.` };
  }
  if (!ACTIVE_STATUSES.includes(request.status)) {
    return { ok: false, error: `Request #${id} is not active (status: \`${request.status}\`) — only active requests can be reported.` };
  }
  if (request.discord_user_id === reporter.id) {
    return { ok: false, error: "You cannot report your own request." };
  }
  try {
    await db.query(
      `INSERT INTO request_reports (request_id, reporter_id, reporter_username, reason)
       VALUES ($1, $2, $3, $4)`,
      [id, reporter.id, reporter.username, reason],
    );
  } catch (err) {
    if (err.code === "23505") {
      return { ok: false, error: `You already reported request #${id}. Other users can add their own warnings.` };
    }
    throw err;
  }
  const reports = await getReports(id);
  return { ok: true, request, reports };
}

async function getReports(requestId) {
  const res = await db.query(
    `SELECT * FROM request_reports WHERE request_id = $1 ORDER BY created_at ASC`,
    [requestId],
  );
  return res.rows;
}

// requestIds -> { [id]: reports[] } for rendering lists efficiently
async function getReportsMap(requestIds) {
  if (!requestIds || requestIds.length === 0) return {};
  const res = await db.query(
    `SELECT * FROM request_reports WHERE request_id = ANY($1) ORDER BY created_at ASC`,
    [requestIds],
  );
  const map = {};
  for (const row of res.rows) {
    (map[row.request_id] = map[row.request_id] || []).push(row);
  }
  return map;
}

async function clearReports(id) {
  await db.query(`DELETE FROM request_reports WHERE request_id = $1`, [id]);
  // Also clear legacy columns so migrated flags don't resurrect on restart
  return updateRequestStatus(id, {
    flag_reason: null,
    flagged_by: null,
    flagged_by_username: null,
    flagged_at: null,
  });
}

module.exports = {
  createRequest,
  setRequestMessage,
  getUserStats,
  getLeaderboard,
  listActiveRequests,
  getRequestById,
  updateRequestStatus,
  invalidateRequest,
  reportRequest,
  getReports,
  getReportsMap,
  clearReports,
};
