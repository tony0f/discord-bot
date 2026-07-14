const db = require("./db");
const pm = require("./polymarket");
const tp = require("./threepo");
const pr = require("./proposalRequests");
const { buildRequestEmbed, buildDashboardEmbed } = require("./embeds");
const { PROPOSAL_REQUESTS_CHANNEL_ID } = require("./config");

let isCycleRunning = false;
const logPrefix = "[PR Watcher]";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isBinaryYesNo(request) {
  try {
    const outcomes = JSON.parse(request.outcomes || "[]").map((o) => String(o).toLowerCase());
    return outcomes.length === 2 && outcomes.includes("yes") && outcomes.includes("no");
  } catch {
    return false;
  }
}

// 3PO maps p-values to Yes/No, which is only trustworthy for binary Yes/No
// markets. For named outcomes (teams, Over/Under) keep the raw p-value unless
// 3PO decoded the actual name.
function labelForRequest(request, tpLabel) {
  if (!tpLabel) return null;
  if (tpLabel === tp.TIE_OUTCOME) return tpLabel;
  if (tpLabel !== "Yes" && tpLabel !== "No") return tpLabel; // decoded name
  if (isBinaryYesNo(request)) return tpLabel;
  return tpLabel === "Yes" ? "p2" : "p1";
}

// Final winner as a name comparable to requested_outcome. Named-outcome
// Polymarket markets fall back to Gamma's snapped prices.
async function resolveWinner(request, res) {
  const label = labelForRequest(request, res.settledOutcome);
  if (label && label !== "p1" && label !== "p2") return label;
  if (request.creation_source !== "predict.fun") {
    try {
      const gamma = await pm.fetchMarketBySlug(request.market_slug);
      if (gamma && pm.isResolved(gamma)) return pm.getWinningOutcome(gamma);
    } catch (err) {
      console.warn(`${logPrefix} Gamma winner fallback failed for #${request.id}:`, err.message);
    }
  }
  return null; // indeterminate — retry next cycle
}

async function editRequestMessage(client, request) {
  if (!request.channel_id || !request.message_id) return;
  try {
    const channel = await client.channels.fetch(request.channel_id);
    const message = await channel.messages.fetch(request.message_id);
    const settings = await db.getSettings();
    const reports = await pr.getReports(request.id);
    await message.edit({
      embeds: [
        buildRequestEmbed(request, {
          creditWindowHours: parseInt(settings.credit_window_hours, 10),
          reports,
        }),
      ],
    });
  } catch (err) {
    console.warn(`${logPrefix} Could not edit message for request #${request.id}:`, err.message);
  }
}

async function notifyResult(client, request) {
  try {
    const channel = await client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
    const correct = request.status === "settled_correct";
    const content = correct
      ? `✅ Request **#${request.id}** by <@${request.discord_user_id}> settled as requested (**${request.settled_outcome}**). Credited to their record!`
      : `❌ Request **#${request.id}** by <@${request.discord_user_id}> settled as **${request.settled_outcome}** (they requested **${request.requested_outcome}**). Counted as incorrect.`;

    const payload = { content };
    if (request.message_id) {
      payload.reply = {
        messageReference: request.message_id,
        failIfNotExists: false,
      };
    }
    await channel.send(payload);
  } catch (err) {
    console.warn(`${logPrefix} Could not send result notification for #${request.id}:`, err.message);
  }
}

async function refreshDashboard(client) {
  if (!db.isEnabled()) return;
  const settings = await db.getSettings();
  const channelId = settings.dashboard_channel_id;
  if (!channelId) return;

  const creditWindowHours = parseInt(settings.credit_window_hours, 10);
  const requests = await pr.listActiveRequests();
  const reportsMap = await pr.getReportsMap(requests.map((r) => r.id));
  const embed = buildDashboardEmbed(requests, { creditWindowHours, reportsMap });

  try {
    const channel = await client.channels.fetch(channelId);
    const messageId = settings.dashboard_message_id;

    if (messageId) {
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({ embeds: [embed] });
        return;
      } catch {
        // Message was deleted — fall through and post a new one
      }
    }
    const newMessage = await channel.send({ embeds: [embed] });
    await db.setSetting("dashboard_message_id", newMessage.id);
  } catch (err) {
    console.warn(`${logPrefix} Could not refresh dashboard:`, err.message);
  }
}

async function runCycle(client) {
  if (isCycleRunning) return;
  isCycleRunning = true;

  try {
    const settings = await db.getSettings();
    const creditWindowHours = parseInt(settings.credit_window_hours, 10);

    // 1. Expire pending requests whose credit window has passed.
    //    This runs BEFORE market checks, so a request can never be credited
    //    for a proposal that arrived after its window.
    const expired = await db.query(
      `UPDATE proposal_requests
       SET status = 'expired', updated_at = now()
       WHERE status = 'pending'
         AND created_at < now() - ($1 * interval '1 hour')
       RETURNING *`,
      [creditWindowHours],
    );
    for (const request of expired.rows) {
      console.log(`${logPrefix} Request #${request.id} expired (no proposal within ${creditWindowHours}h).`);
      await editRequestMessage(client, request);
    }

    // 2. Check market state for every active request via 3PO.
    const active = await pr.listActiveRequests();
    for (const request of active) {
      let market;
      try {
        market = await tp.getMarket(request.question_id || request.market_slug);
      } catch (err) {
        console.warn(`${logPrefix} 3PO error for #${request.id} (${request.market_slug}):`, err.message);
        continue;
      }
      const res = tp.extractResolution(market);

      if (res.settled) {
        const winner = await resolveWinner(request, res);
        if (!winner) {
          console.warn(`${logPrefix} Request #${request.id}: settled but winner indeterminate. Will retry.`);
          continue;
        }
        const correct = winner === request.requested_outcome;
        const updated = await pr.updateRequestStatus(request.id, {
          status: correct ? "settled_correct" : "settled_incorrect",
          settled_at: new Date(),
          settled_outcome: winner,
          proposed_at: request.proposed_at || new Date(),
        });
        console.log(
          `${logPrefix} Request #${request.id} settled ${correct ? "CORRECT" : "INCORRECT"} (winner: ${winner}).`,
        );
        await editRequestMessage(client, updated);
        await notifyResult(client, updated);
      } else if (tp.hasLiveProposal(res.status)) {
        const proposedOutcome = labelForRequest(request, res.proposedOutcome);
        if (request.status === "pending" || request.proposed_outcome !== proposedOutcome) {
          const updated = await pr.updateRequestStatus(request.id, {
            status: "proposed",
            proposed_at: request.proposed_at || new Date(),
            proposed_outcome: proposedOutcome,
          });
          console.log(
            `${logPrefix} Request #${request.id} proposed as "${proposedOutcome}" (requested "${request.requested_outcome}").`,
          );
          await editRequestMessage(client, updated);
        }
      } else if (request.status === "proposed") {
        // Proposal knocked out (disputed / extended review) — a fresh proposal
        // is needed. Revert; the window keeps counting from created_at.
        const updated = await pr.updateRequestStatus(request.id, {
          status: "pending",
          proposed_at: null,
          proposed_outcome: null,
        });
        console.log(`${logPrefix} Request #${request.id} proposal knocked out (${res.status}). Reverted to pending.`);
        await editRequestMessage(client, updated);
      }

      await sleep(300); // be gentle with the API
    }

    // 3. Refresh the live board.
    await refreshDashboard(client);
  } catch (err) {
    console.error(`${logPrefix} Cycle error:`, err);
  } finally {
    isCycleRunning = false;
  }
}

// Self-rescheduling loop so poll-interval changes apply without a restart.
function start(client) {
  if (!db.isEnabled()) {
    console.warn(`${logPrefix} Database disabled — watcher not started.`);
    return;
  }

  const tick = async () => {
    await runCycle(client);
    let minutes = 5;
    try {
      const settings = await db.getSettings();
      const parsed = parseInt(settings.poll_interval_minutes, 10);
      if (!Number.isNaN(parsed) && parsed >= 1) minutes = parsed;
    } catch {
      /* keep default */
    }
    setTimeout(tick, minutes * 60 * 1000);
  };

  console.log(`${logPrefix} Started.`);
  tick();
}

module.exports = { start, runCycle, refreshDashboard, editRequestMessage };
