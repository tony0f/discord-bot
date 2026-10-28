// Support-tickets keeper: Tickety (threads mode) tickets disappear from the
// channel list once they are inactive for longer than their auto-archive
// duration (7 days). Discord no longer truly archives them on time — clients
// just HIDE active threads past that window — so unarchiving alone does
// nothing: the only reliable way to keep an open ticket visible is fresh
// activity. Once a day this module:
//
//   1. un-archives any archived-but-open ticket (lazy archiving still happens)
//   2. posts a small keep-alive message in every open ticket with no activity
//      for BUMP_AFTER_DAYS, which resets the client's hide timer
//   3. posts a detailed report to #violation-alerts
//
// "Closed" = Tickety locks + archives the thread (verified live), or the
// name starts with "closed"/"cerrado". Locked tickets are never touched.
const {
  SUPPORT_TICKETS_CHANNEL_ID,
  VERIFIERS_ALERTS_CHANNEL_ID,
  TICKET_SWEEP_UTC_TIME,
} = require("./config");

const logPrefix = "[Tickets]";
const CLOSED_NAME = /^(closed|cerrado)/i;
const MAX_ARCHIVE_PAGES = 50; // 100 threads per page, per type
const MAX_AUTO_ARCHIVE_MINUTES = 10080; // 7 days — Discord's maximum
// Bump just before the 7-day hide window closes; also rescues already-hidden
// tickets, since a hidden thread is simply an active one past the window.
const BUMP_AFTER_DAYS = parseInt(process.env.TICKET_KEEPALIVE_DAYS || "6", 10);
const DAY_MS = 24 * 60 * 60 * 1000;

const KEEPALIVE_TEXT =
  "🔔 This ticket is still open — keep-alive bump so it stays visible for the team.";

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

function snowflakeMs(id) {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}

function lastActivityMs(thread) {
  if (thread.lastMessageId) return snowflakeMs(thread.lastMessageId);
  return thread.createdTimestamp || Date.now();
}

function isClosed(thread) {
  return thread.locked || CLOSED_NAME.test(thread.name || "");
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

// Sends the keep-alive, joining the private thread first if membership is
// required. Throws if both attempts fail.
async function sendKeepAlive(thread) {
  try {
    await thread.send(KEEPALIVE_TEXT);
  } catch (err) {
    await thread.join().catch(() => {});
    await thread.send(KEEPALIVE_TEXT);
  }
}

async function runTicketSweep(client) {
  const startedAt = Date.now();
  const result = {
    activeOpen: 0,
    archivedScanned: 0,
    closedCount: 0,
    unarchived: [],
    bumped: [],
    errors: [],
  };

  const channel = await client.channels.fetch(SUPPORT_TICKETS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.threads) {
    console.error(`${logPrefix} Support-tickets channel ${SUPPORT_TICKETS_CHANNEL_ID} not accessible.`);
    result.errors.push("Could not access the #support-tickets channel (check View Channel permission).");
    await postReport(client, result, startedAt);
    return result;
  }

  // 1. Archived threads: un-archive any that still look open. They will be
  //    hidden again by the client until the bump below gives them activity.
  let archived = [];
  for (const type of ["private", "public"]) {
    try {
      archived = archived.concat(await fetchAllArchived(channel, type));
    } catch (err) {
      console.error(`${logPrefix} Failed to list ${type} archived threads:`, err.message);
      result.errors.push(`Listing ${type} archived threads failed: ${err.message}`);
    }
  }
  result.archivedScanned = archived.length;

  const candidates = new Map(); // id -> thread, every open ticket
  for (const thread of archived) {
    if (isClosed(thread)) {
      result.closedCount++;
      continue;
    }
    try {
      await thread.edit({
        archived: false,
        autoArchiveDuration: MAX_AUTO_ARCHIVE_MINUTES,
        reason: "Ticket still open — unarchived by the daily sweep",
      });
      result.unarchived.push(thread.id);
      candidates.set(thread.id, thread);
      await sleep(350);
    } catch (err) {
      console.error(`${logPrefix} Could not unarchive ${thread.id} (${thread.name}):`, err.message);
      result.errors.push(`Unarchive failed for "${thread.name}": ${err.message}`);
    }
  }

  // 2. Active threads: these include the "hidden" ones — Discord clients hide
  //    (not archive) threads inactive past their auto-archive duration. The
  //    gateway syncs ALL private threads into the cache (ManageThreads grants
  //    access) even when the bot is not a member; the REST active listing
  //    does NOT include those, so the cache is the source of truth here.
  for (const thread of channel.threads.cache.values()) {
    if (thread.archived || isClosed(thread)) continue;
    candidates.set(thread.id, thread);
  }
  result.activeOpen = candidates.size;

  // 3. Keep-alive bump for every open ticket close to (or past) the hide window.
  const cutoff = Date.now() - BUMP_AFTER_DAYS * DAY_MS;
  for (const thread of candidates.values()) {
    const lastActivity = lastActivityMs(thread);
    if (lastActivity > cutoff) continue;
    try {
      await sendKeepAlive(thread);
      result.bumped.push({
        id: thread.id,
        name: thread.name,
        idleDays: Math.floor((Date.now() - lastActivity) / DAY_MS),
        lastActivity,
      });
      await sleep(350);
    } catch (err) {
      console.error(`${logPrefix} Keep-alive failed for ${thread.id} (${thread.name}):`, err.message);
      result.errors.push(`Keep-alive failed for "${thread.name}": ${err.message}`);
    }
  }

  console.log(
    `${logPrefix} Sweep done: ${result.activeOpen} open tickets, ` +
      `${result.bumped.length} bumped, ${result.unarchived.length} unarchived, ` +
      `${result.closedCount} closed, ${result.errors.length} errors (${Date.now() - startedAt}ms).`
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
    color: hasErrors ? 0xe74c3c : result.bumped.length > 0 ? 0xf1c40f : 0x2ecc71,
    description:
      `Open tickets in <#${SUPPORT_TICKETS_CHANNEL_ID}>: **${result.activeOpen}** · ` +
      `closed (locked) archived: **${result.closedCount}**.\n` +
      `Kept visible with a bump: **${result.bumped.length}** · ` +
      `un-archived: **${result.unarchived.length}**.`,
    fields: [],
    footer: {
      text:
        `Bump threshold: ${BUMP_AFTER_DAYS}d idle · sweep took ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s · runs daily at ${TICKET_SWEEP_UTC_TIME} UTC`,
    },
    timestamp: new Date().toISOString(),
  };

  if (result.bumped.length > 0) {
    embed.fields.push({
      name: "🔔 Bumped back to visible (still open)",
      value: listLines(
        result.bumped,
        (t) => `• <#${t.id}> — idle ${t.idleDays}d, last activity <t:${Math.floor(t.lastActivity / 1000)}:R>`
      ).slice(0, 1024),
    });
  } else if (!hasErrors) {
    embed.fields.push({
      name: "✅ All clear",
      value: "Every open ticket has recent activity — nothing was hidden or about to hide.",
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
