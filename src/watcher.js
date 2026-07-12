const db = require("./db");
const pm = require("./polymarket");
const pr = require("./proposalRequests");
const { buildRequestEmbed, buildDashboardEmbed } = require("./embeds");
const { PROPOSAL_REQUESTS_CHANNEL_ID } = require("./config");

let isCycleRunning = false;
const logPrefix = "[PR Watcher]";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

    // 2. Check market state for every active request.
    const active = await pr.listActiveRequests();
    for (const request of active) {
      let market;
      try {
        market = await pm.fetchMarketBySlug(request.market_slug);
      } catch (err) {
        console.warn(`${logPrefix} Gamma error for ${request.market_slug}:`, err.message);
        continue;
      }
      if (!market) {
        console.warn(`${logPrefix} Market ${request.market_slug} not found on Gamma (request #${request.id}).`);
        continue;
      }

      if (pm.isResolved(market)) {
        const winner = pm.getWinningOutcome(market);
        if (!winner) {
          console.warn(`${logPrefix} Request #${request.id}: market resolved but winner indeterminate. Will retry.`);
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
      } else if (pm.hasProposal(market)) {
        if (request.status === "pending") {
          const updated = await pr.updateRequestStatus(request.id, {
            status: "proposed",
            proposed_at: new Date(),
          });
          console.log(`${logPrefix} Request #${request.id} marked as proposed (${market.umaResolutionStatus}).`);
          await editRequestMessage(client, updated);
        }
      } else if (request.status === "proposed") {
        // The proposal disappeared (e.g. disputed as too-early and reset).
        // Revert to pending; the window keeps counting from created_at.
        const updated = await pr.updateRequestStatus(request.id, {
          status: "pending",
          proposed_at: null,
        });
        console.log(`${logPrefix} Request #${request.id} proposal was reset on-chain. Reverted to pending.`);
        await editRequestMessage(client, updated);
      }

      await sleep(300); // be gentle with the Gamma API
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
