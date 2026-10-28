// Support-tickets keeper: Tickety (threads mode) tickets auto-archive after
// 7 days of inactivity even when the ticket is still open, hiding them from
// the team. Once a day this module walks every archived thread in
// #support-tickets, un-archives the ones that still look open, and posts a
// detailed report to #violation-alerts.
//
// "Closed" heuristic: a thread is left archived when it is locked or its
// name starts with "closed"/"cerrado" — anything else is treated as an open
// ticket. The report lists both groups so the heuristic can be verified.
const {
  SUPPORT_TICKETS_CHANNEL_ID,
  VERIFIERS_ALERTS_CHANNEL_ID,
  TICKET_SWEEP_UTC_TIME,
} = require("./config");

const logPrefix = "[Tickets]";
const CLOSED_NAME = /^(closed|cerrado)/i;
const MAX_ARCHIVE_PAGES = 50; // 100 threads per page, per type
const MAX_AUTO_ARCHIVE_MINUTES = 10080; // 7 days — Discord's maximum

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseSweepTime(raw) {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(raw || "").trim());
  const hour = match ? Math.min(23, parseInt(match[1], 10)) : 13;
  const minute = match && match[2] ? Math.min(59, parseInt(match[2], 10)) : 0;
  return { hour, minute };
}

function msUntilNextRun() {
  const { hour, minute } = parseSweepTime(TICKET_SWEEP_UTC_TIME);
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0)
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// Walks one archived listing (public or private) through pagination. The
// private listing requires ManageThreads + fetchAll, which the bot has.
async function fetchAllArchived(channel, type) {
  const all = new Map();
  let before;
  for (let page = 0; page < MAX_ARCHIVE_PAGES; page++) {
    const batch = await channel.threads.fetchArchived({
      type,
      fetchAll: true,
      limit: 100,
      before,
    });
    for (const thread of batch.threads.values()) all.set(thread.id, thread);
    if (!batch.hasMore || batch.threads.size === 0) break;
    const oldest = [...batch.threads.values()].at(-1);
    if (!oldest || oldest === before) break;
    before = oldest;
    await sleep(250);
  }
  return [...all.values()];
}

async function runTicketSweep(client) {
  const startedAt = Date.now();
  const result = { scanned: 0, reopened: [], leftArchived: [], errors: [] };

  const channel = await client.channels.fetch(SUPPORT_TICKETS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.threads) {
    console.error(`${logPrefix} Support-tickets channel ${SUPPORT_TICKETS_CHANNEL_ID} not accessible.`);
    result.errors.push("Could not access the #support-tickets channel (check View Channel permission).");
    await postReport(client, result, startedAt);
    return result;
  }

  let archived = [];
  for (const type of ["private", "public"]) {
    try {
      archived = archived.concat(await fetchAllArchived(channel, type));
    } catch (err) {
      console.error(`${logPrefix} Failed to list ${type} archived threads:`, err.message);
      result.errors.push(`Listing ${type} archived threads failed: ${err.message}`);
    }
  }
  // The two listings never overlap, but a retried page could duplicate.
  const seen = new Set();
  archived = archived.filter((t) => !seen.has(t.id) && seen.add(t.id));
  result.scanned = archived.length;

  for (const thread of archived) {
    const looksClosed = thread.locked || CLOSED_NAME.test(thread.name || "");
    if (looksClosed) {
      result.leftArchived.push({
        id: thread.id,
        name: thread.name,
        reason: thread.locked ? "locked" : "name says closed",
      });
      continue;
    }
    try {
      await thread.edit({
        archived: false,
        autoArchiveDuration: MAX_AUTO_ARCHIVE_MINUTES,
        reason: "Ticket still open — unarchived by the daily sweep",
      });
      result.reopened.push({
        id: thread.id,
        name: thread.name,
        createdTimestamp: thread.createdTimestamp,
        archivedTimestamp: thread.archiveTimestamp,
      });
      await sleep(350);
    } catch (err) {
      console.error(`${logPrefix} Could not unarchive ${thread.id} (${thread.name}):`, err.message);
      result.errors.push(`Unarchive failed for "${thread.name}": ${err.message}`);
    }
  }

  console.log(
    `${logPrefix} Sweep done: ${result.scanned} archived, ` +
      `${result.reopened.length} reopened, ${result.leftArchived.length} left closed, ` +
      `${result.errors.length} errors (${Date.now() - startedAt}ms).`
  );
  await postReport(client, result, startedAt);
  return result;
}

function listLines(items, formatter, maxLines = 15) {
  const lines = items.slice(0, maxLines).map(formatter);
  if (items.length > maxLines) lines.push(`…and ${items.length - maxLines} more`);
  return lines.join("\n");
}

async function postReport(client, result, startedAt) {
  const alerts = await client.channels.fetch(VERIFIERS_ALERTS_CHANNEL_ID).catch(() => null);
  if (!alerts) {
    console.error(`${logPrefix} Alerts channel not accessible — report skipped.`);
    return;
  }

  const hasErrors = result.errors.length > 0;
  const embed = {
    title: "🎫 Daily support-tickets sweep",
    color: hasErrors ? 0xe74c3c : result.reopened.length > 0 ? 0xf1c40f : 0x2ecc71,
    description:
      `Scanned **${result.scanned}** archived thread(s) in <#${SUPPORT_TICKETS_CHANNEL_ID}>.\n` +
      `Reopened **${result.reopened.length}** still-open ticket(s) · ` +
      `left **${result.leftArchived.length}** closed one(s) archived.`,
    fields: [],
    footer: { text: `Sweep took ${((Date.now() - startedAt) / 1000).toFixed(1)}s · runs daily at ${TICKET_SWEEP_UTC_TIME} UTC` },
    timestamp: new Date().toISOString(),
  };

  if (result.reopened.length > 0) {
    embed.fields.push({
      name: "🔓 Reopened (ticket still open)",
      value: listLines(
        result.reopened,
        (t) =>
          `• <#${t.id}> — opened <t:${Math.floor(t.createdTimestamp / 1000)}:R>` +
          (t.archivedTimestamp ? `, was hidden since <t:${Math.floor(t.archivedTimestamp / 1000)}:R>` : "")
      ).slice(0, 1024),
    });
  } else if (!hasErrors) {
    embed.fields.push({
      name: "✅ All clear",
      value: "No open tickets were hidden by auto-archive today.",
    });
  }

  if (result.leftArchived.length > 0) {
    embed.fields.push({
      name: "🔒 Left archived (look closed)",
      value: listLines(result.leftArchived, (t) => `• ${t.name} (${t.reason})`).slice(0, 1024),
    });
  }

  if (hasErrors) {
    embed.fields.push({
      name: "⚠️ Errors",
      value: listLines(result.errors, (e) => `• ${e}`, 10).slice(0, 1024),
    });
  }

  await alerts.send({ embeds: [embed] }).catch((err) => {
    console.error(`${logPrefix} Failed to post report:`, err.message);
  });
}

function start(client) {
  if (!SUPPORT_TICKETS_CHANNEL_ID) {
    console.warn(`${logPrefix} No support-tickets channel configured — keeper disabled.`);
    return;
  }
  const schedule = () => {
    const ms = msUntilNextRun();
    console.log(`${logPrefix} Next sweep in ${(ms / 3600000).toFixed(1)}h (daily at ${TICKET_SWEEP_UTC_TIME} UTC).`);
    setTimeout(async () => {
      try {
        await runTicketSweep(client);
      } catch (err) {
        console.error(`${logPrefix} Sweep crashed:`, err);
      }
      schedule();
    }, ms);
  };
  schedule();
}

module.exports = { start, runTicketSweep };
