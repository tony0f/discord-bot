const db = require("./db");
const pm = require("./polymarket");
const tp = require("./threepo");
const pr = require("./proposalRequests");
const { buildRequestEmbed, buildDashboardEmbed } = require("./embeds");
const { PROPOSAL_REQUESTS_CHANNEL_ID } = require("./config");
const onchain = require("./onchain");

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

// 3PO maps p-values to Yes/No, which is only literal for binary Yes/No
// markets. For two named outcomes (teams, Over/Under) the CTF adapter
// convention is fixed: p2 pays out the FIRST outcome, p1 the SECOND
// (resolved p2 → outcomePrices ["1","0"]) — confirmed against the UMA
// explorer's decoded values (P2 = PCIFIC, P1 = Under).
function labelForRequest(request, tpLabel) {
  if (!tpLabel) return null;
  if (tpLabel === tp.TIE_OUTCOME) return tpLabel;
  if (tpLabel !== "Yes" && tpLabel !== "No") return tpLabel; // decoded name
  if (isBinaryYesNo(request)) return tpLabel;
  try {
    const outcomes = JSON.parse(request.outcomes || "[]");
    if (outcomes.length === 2) {
      return tpLabel === "Yes" ? outcomes[0] : outcomes[1];
    }
  } catch {
    /* fall through to raw p-values */
  }
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

async function notifyReview(client, request) {
  try {
    const channel = await client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
    const payload = {
      content:
        `🟡 Request **#${request.id}** by <@${request.discord_user_id}> settled as requested (**${request.settled_outcome}**), ` +
        `but it carried community warnings from before the proposal — **credit is under admin review**.`,
    };
    if (request.message_id) {
      payload.reply = { messageReference: request.message_id, failIfNotExists: false };
    }
    await channel.send(payload);
  } catch (err) {
    console.warn(`${logPrefix} Could not send review notification for #${request.id}:`, err.message);
  }
}

// Deletes every bot message tied to a request: the card (whose id is also
// the discussion thread's id), tracked evidence messages, and a best-effort
// sweep of recent bot messages that reference the request.
async function purgeRequestMessages(client, request) {
  if (!request.channel_id) return;
  try {
    const channel = await client.channels.fetch(request.channel_id);

    if (request.message_id) {
      const thread = await channel.threads.fetch(request.message_id).catch(() => null);
      if (thread) {
        await thread.delete("Request invalidated").catch((err) =>
          console.warn(`${logPrefix} Could not delete thread for #${request.id}:`, err.message),
        );
      }
      await channel.messages.delete(request.message_id).catch(() => {});
    }

    let evidenceIds = [];
    try {
      evidenceIds = JSON.parse(request.evidence_message_ids || "[]");
    } catch {
      /* legacy rows */
    }
    for (const id of evidenceIds) {
      await channel.messages.delete(id).catch(() => {});
    }

    // Sweep recent bot messages about this request (results, warnings, older
    // evidence posts that predate evidence_message_ids tracking)
    const idPattern = new RegExp(`#${request.id}\\b`);
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (recent) {
      for (const msg of recent.values()) {
        if (msg.author.id !== client.user.id) continue;
        const repliesToCard =
          request.message_id && msg.reference?.messageId === request.message_id;
        if (repliesToCard || (idPattern.test(msg.content || "") && /request/i.test(msg.content || ""))) {
          await msg.delete().catch(() => {});
        }
      }
    }
    console.log(`${logPrefix} Purged Discord messages for request #${request.id}.`);
  } catch (err) {
    console.warn(`${logPrefix} Purge failed for #${request.id}:`, err.message);
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

    // 0. Repair tie settlements once mislabeled by verbose 3PO decoded labels
    //    ("unknown/50-50" !== "50-50"). Idempotent: matches nothing once clean.
    const repaired = await db.query(
      `UPDATE proposal_requests
       SET status = 'settled_correct', settled_outcome = '50-50', updated_at = now()
       WHERE status = 'settled_incorrect'
         AND requested_outcome = '50-50'
         AND (settled_outcome ILIKE '%50-50%' OR settled_outcome ILIKE '%50/50%'
              OR settled_outcome ILIKE 'unknown%' OR settled_outcome ILIKE 'tie%')
       RETURNING *`,
    );
    for (const request of repaired.rows) {
      console.log(`${logPrefix} Repaired mislabeled tie settlement on request #${request.id}.`);
      await editRequestMessage(client, request);
      try {
        const channel = await client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
        const payload = {
          content: `✅ **Correction:** request **#${request.id}** by <@${request.discord_user_id}> settled exactly as requested (**50-50**) — the earlier "incorrect" verdict was a labeling bug on our side. Credited to their record.`,
        };
        if (request.message_id) {
          payload.reply = { messageReference: request.message_id, failIfNotExists: false };
        }
        await channel.send(payload);
      } catch (err) {
        console.warn(`${logPrefix} Could not announce repair for #${request.id}:`, err.message);
      }
    }

    // 0b. Repair settlements once broken by upstream whitespace in outcome
    //     names ("PCIFIC " vs "PCIFIC"). Requests with warnings predating the
    //     proposal go to review instead of silent credit. Idempotent.
    const wsCandidates = await db.query(
      `SELECT * FROM proposal_requests
       WHERE status = 'settled_incorrect' AND settled_outcome IS NOT NULL`,
    );
    for (const request of wsCandidates.rows) {
      if (pm.outcomeKey(request.settled_outcome) !== pm.outcomeKey(request.requested_outcome)) {
        continue;
      }
      const reports = await pr.getReports(request.id);
      const proposedAt = new Date(request.proposed_at || request.settled_at || Date.now());
      const held = reports.some((rep) => new Date(rep.created_at) < proposedAt);
      const updated = await pr.updateRequestStatus(request.id, {
        status: held ? "under_review" : "settled_correct",
        settled_outcome: request.requested_outcome,
      });
      console.log(`${logPrefix} Repaired whitespace-mismatched settlement on #${request.id} → ${updated.status}.`);
      await editRequestMessage(client, updated);
      try {
        const channel = await client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
        const payload = {
          content: held
            ? `🟡 **Correction:** request **#${request.id}** by <@${request.discord_user_id}> actually settled as requested (**${updated.settled_outcome}**) — the "incorrect" verdict was a labeling bug. It carried pre-proposal community warnings, so **credit is under admin review**.`
            : `✅ **Correction:** request **#${request.id}** by <@${request.discord_user_id}> settled exactly as requested (**${updated.settled_outcome}**) — the earlier "incorrect" verdict was a labeling bug on our side. Credited to their record.`,
        };
        if (request.message_id) {
          payload.reply = { messageReference: request.message_id, failIfNotExists: false };
        }
        await channel.send(payload);
      } catch (err) {
        console.warn(`${logPrefix} Could not announce whitespace repair for #${request.id}:`, err.message);
      }
    }

    // 0c. Denied credits recorded as neutral "invalidated" before the
    //     deny-as-loss rule existed (they had already settled when the admin
    //     acted) become losses. Idempotent: new denials never hit this state.
    const denied = await db.query(
      `UPDATE proposal_requests
       SET status = 'settled_incorrect', updated_at = now()
       WHERE status = 'invalidated' AND settled_outcome IS NOT NULL
       RETURNING *`,
    );
    for (const request of denied.rows) {
      console.log(`${logPrefix} Reclassified denied credit on #${request.id} as a loss.`);
      await editRequestMessage(client, request);
      try {
        const channel = await client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
        const payload = {
          content: `❌ Request **#${request.id}** by <@${request.discord_user_id}>: credit was **denied after admin review** — requesting it at that moment would have caused a P4/dispute. Counted as **incorrect**.`,
        };
        if (request.message_id) {
          payload.reply = { messageReference: request.message_id, failIfNotExists: false };
        }
        await channel.send(payload);
      } catch (err) {
        console.warn(`${logPrefix} Could not announce denial for #${request.id}:`, err.message);
      }
    }

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
        const correct = pm.outcomeKey(winner) === pm.outcomeKey(request.requested_outcome);
        let status = correct ? "settled_correct" : "settled_incorrect";
        // Correct settlements that carried a community warning BEFORE the
        // proposal (e.g. a genuine "too early / P4" flag) are not credited
        // automatically — an admin approves or invalidates.
        if (correct) {
          const reports = await pr.getReports(request.id);
          const proposedAt = new Date(request.proposed_at || Date.now());
          if (reports.some((rep) => new Date(rep.created_at) < proposedAt)) {
            status = "under_review";
          }
        }
        const fields = {
          status,
          settled_at: new Date(),
          settled_outcome: winner,
          proposed_at: request.proposed_at || new Date(),
        };
        // Capture the proposal tx/wallet if the request skipped the proposed
        // state between polls
        if (res.proposeTx && res.proposeTx !== request.propose_tx) {
          fields.propose_tx = res.proposeTx;
          fields.proposer_address = await onchain.getTxSender(res.proposeTx, request.creation_source);
        }
        const updated = await pr.updateRequestStatus(request.id, fields);
        console.log(`${logPrefix} Request #${request.id} settled → ${status} (winner: ${winner}).`);
        await editRequestMessage(client, updated);
        if (status === "under_review") {
          await notifyReview(client, updated);
        } else {
          await notifyResult(client, updated);
        }
      } else if (tp.hasLiveProposal(res.status)) {
        const proposedOutcome = labelForRequest(request, res.proposedOutcome);
        const txChanged = res.proposeTx && res.proposeTx !== request.propose_tx;
        if (
          request.status === "pending" ||
          request.proposed_outcome !== proposedOutcome ||
          txChanged
        ) {
          const fields = {
            status: "proposed",
            proposed_at: request.proposed_at || new Date(),
            proposed_outcome: proposedOutcome,
          };
          if (txChanged) {
            fields.propose_tx = res.proposeTx;
            fields.proposer_address = await onchain.getTxSender(res.proposeTx, request.creation_source);
          }
          const updated = await pr.updateRequestStatus(request.id, fields);
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
          propose_tx: null,
          proposer_address: null,
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

module.exports = {
  start,
  runCycle,
  refreshDashboard,
  editRequestMessage,
  purgeRequestMessages,
  notifyResult,
};
