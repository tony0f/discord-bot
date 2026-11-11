// Proposer-whitelist workflow: reads the on-chain UMA AddressWhitelist on
// Polygon, keeps user_flags.whitelisted in sync with it, collects wallets
// from qualified users, and posts the monthly wallet-collection reminder.
//
// Tony's monthly routine: the cut is on the 3rd, the on-chain whitelist is
// updated around the 10th. The bot's part: on the 1st it pings qualified,
// not-yet-whitelisted users in #proposal-requests to save their wallet
// (/mywallet or the 💳 button); the dashboard serves the copy-paste batch;
// a daily on-chain sync flips the Whitelisted flag once wallets land in the
// contract. The sync only ever sets whitelisted=true — it never unsets, so
// manual dashboard toggles are preserved.
const db = require("./db");
const pr = require("./proposalRequests");
const {
  WHITELIST_CONTRACT_ADDRESS,
  PROPOSAL_REQUESTS_CHANNEL_ID,
  PROPOSAL_BOT_CHANNEL_ID,
  VERIFIERS_ALERTS_CHANNEL_ID,
  QUALIFY_MIN_SETTLED,
  QUALIFY_MIN_ACCURACY,
} = require("./config");

const logPrefix = "[Whitelist]";
const RPC_URL = "https://polygon.drpc.org";
const GET_WHITELIST_SELECTOR = "0xd01f63f5"; // getWhitelist() → address[]

// One-time wallet import for users whitelisted manually before the bot
// stored wallets. The username→wallet pairs are deliberately NOT in the
// source (identity↔wallet mappings don't belong in git): they come from the
// WALLET_SEED env var — "username=0xWallet" pairs separated by commas or
// newlines — which can be removed from Railway once the seed reports done.
function parseSeedPairs() {
  const raw = process.env.WALLET_SEED || "";
  const pairs = [];
  for (const chunk of raw.split(/[\n,]+/)) {
    const match = /^\s*(.+?)\s*[=:]\s*(0x[a-fA-F0-9]{40})\s*$/.exec(chunk);
    if (match) pairs.push([match[1], match[2]]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// On-chain read + sync
// ---------------------------------------------------------------------------

// Calls getWhitelist() and decodes the returned address[] (lowercased Set).
async function fetchOnchainWhitelist() {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: WHITELIST_CONTRACT_ADDRESS, data: GET_WHITELIST_SELECTOR }, "latest"],
    }),
  });
  const { result, error } = await res.json();
  if (error || !result || result === "0x") {
    throw new Error(`getWhitelist failed: ${error?.message || "empty result"}`);
  }
  const hex = result.slice(2);
  const length = parseInt(hex.slice(64, 128), 16);
  const addresses = new Set();
  for (let i = 0; i < length; i++) {
    const word = hex.slice(128 + i * 64, 128 + (i + 1) * 64);
    addresses.add("0x" + word.slice(24).toLowerCase());
  }
  return addresses;
}

// Flips whitelisted=true for every stored wallet found on-chain. Never
// unsets: admin toggles in the dashboard stay authoritative for removals.
async function syncWhitelistFlags() {
  const onchain = await fetchOnchainWhitelist();
  const flipped = await db.query(
    `UPDATE user_flags
     SET whitelisted = TRUE, updated_at = now()
     WHERE whitelisted = FALSE
       AND wallet IS NOT NULL
       AND lower(wallet) = ANY($1)
     RETURNING discord_user_id, username, wallet`,
    [[...onchain]],
  );
  await db.setSetting("whitelist_onchain_size", String(onchain.size));
  await db.setSetting("whitelist_last_sync", new Date().toISOString());
  if (flipped.rows.length > 0) {
    console.log(
      `${logPrefix} On-chain sync: marked ${flipped.rows.length} user(s) as whitelisted ` +
        `(${flipped.rows.map((r) => r.username || r.discord_user_id).join(", ")}).`,
    );
  }
  return { flipped: flipped.rows, onchainSize: onchain.size };
}

// ---------------------------------------------------------------------------
// Qualified users + monthly batch
// ---------------------------------------------------------------------------

// Leaderboard users meeting the whitelist criteria, joined with their flags.
async function getQualifiedUsers() {
  const leaderboard = await pr.getLeaderboard(500);
  const qualified = leaderboard.filter(
    (r) => r.settled >= QUALIFY_MIN_SETTLED && r.accuracy >= QUALIFY_MIN_ACCURACY,
  );
  if (qualified.length === 0) return [];
  const flags = await db.query(
    `SELECT * FROM user_flags WHERE discord_user_id = ANY($1)`,
    [qualified.map((r) => r.userId)],
  );
  const byId = Object.fromEntries(flags.rows.map((f) => [f.discord_user_id, f]));
  return qualified.map((r) => ({
    ...r,
    flags: byId[r.userId] || { contacted: false, whitelisted: false, wallet: null, note: null },
  }));
}

// Sheet-ready batch: "username - request bot<TAB>wallet" per line, matching
// the format of Tony's whitelist spreadsheet.
function batchCopyText(rows) {
  return rows.map((r) => `${r.username} - request bot\t${r.flags.wallet}`).join("\n");
}

async function getWhitelistBatch() {
  const qualified = await getQualifiedUsers();
  const pending = qualified.filter((r) => !r.flags.whitelisted);
  const ready = pending.filter((r) => r.flags.wallet);
  const missingWallet = pending.filter((r) => !r.flags.wallet);
  const settings = await db.getSettings();
  return {
    qualifiedCount: qualified.length,
    whitelistedCount: qualified.length - pending.length,
    ready,
    missingWallet,
    copyText: batchCopyText(ready),
    lastSync: settings.whitelist_last_sync || null,
    onchainSize: parseInt(settings.whitelist_onchain_size || "0", 10) || null,
  };
}

// ---------------------------------------------------------------------------
// Scheduled tasks, driven by the watcher cycle (all settings-deduped)
// ---------------------------------------------------------------------------

async function sendChunked(channel, lines) {
  let buffer = "";
  for (const line of lines) {
    if (buffer.length + line.length + 1 > 1900) {
      await channel.send({ content: buffer, allowedMentions: { parse: ["users"] } });
      buffer = "";
    }
    buffer += (buffer ? "\n" : "") + line;
  }
  if (buffer) await channel.send({ content: buffer, allowedMentions: { parse: ["users"] } });
}

// On the 1st of each month: ping qualified, not-yet-whitelisted users so the
// missing wallets arrive before the cut on the 3rd.
async function maybeMonthlyReminder(client, settings) {
  const now = new Date();
  if (now.getUTCDate() !== 1) return;
  const monthKey = now.toISOString().slice(0, 7); // YYYY-MM
  if (settings.whitelist_reminder_month === monthKey) return;
  await db.setSetting("whitelist_reminder_month", monthKey); // set first — never double-ping

  const batch = await getWhitelistBatch();
  const pending = [...batch.ready, ...batch.missingWallet];
  if (pending.length === 0) {
    console.log(`${logPrefix} Monthly reminder: no qualified users pending whitelisting.`);
    return;
  }
  const channel = await client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const lines = [
    `📋 **Monthly proposer-whitelist review** — the cut is on the **3rd**.`,
    `These requesters currently meet the criteria (**${QUALIFY_MIN_SETTLED}+ correct settles** with **≥${Math.round(QUALIFY_MIN_ACCURACY * 100)}% accuracy**, rolling 6 months):`,
    "",
  ];
  for (const r of batch.ready) {
    lines.push(`✅ <@${r.userId}> — wallet on file`);
  }
  for (const r of batch.missingWallet) {
    lines.push(`⚠️ <@${r.userId}> — **no wallet yet**`);
  }
  lines.push("");
  lines.push(
    `Missing yours? Save it with **/mywallet** or the 💳 **My wallet** button in <#${PROPOSAL_BOT_CHANNEL_ID}> before the 3rd to be included in this month's batch.`,
  );
  await sendChunked(channel, lines);
  console.log(`${logPrefix} Monthly reminder sent (${pending.length} pending user(s)).`);
}

// One-time seed of the manually-collected wallets. Usernames are resolved to
// Discord ids through their own proposal requests; unmatched names are
// reported to #violation-alerts instead of guessed.
async function maybeSeedInitialWallets(client, settings) {
  if (settings.wallet_seed_done === "1") return;
  const pairs = parseSeedPairs();
  if (pairs.length === 0) return; // env var not set yet — try again next cycle
  await db.setSetting("wallet_seed_done", "1"); // set first — never re-run

  const seeded = [];
  const skipped = [];
  for (const [name, wallet] of pairs) {
    const match = await db.query(
      `SELECT DISTINCT discord_user_id, MAX(discord_username) AS username
       FROM proposal_requests
       WHERE lower(discord_username) = lower($1) OR lower(discord_display_name) = lower($1)
       GROUP BY discord_user_id`,
      [name],
    );
    if (match.rows.length !== 1) {
      skipped.push(`${name} (${match.rows.length === 0 ? "no requests found" : "ambiguous"})`);
      continue;
    }
    const { discord_user_id, username } = match.rows[0];
    await db.query(
      `INSERT INTO user_flags (discord_user_id, username, contacted, wallet, updated_at)
       VALUES ($1, $2, TRUE, $3, now())
       ON CONFLICT (discord_user_id) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, user_flags.username),
         contacted = TRUE,
         wallet = EXCLUDED.wallet,
         updated_at = now()`,
      [discord_user_id, username || name, wallet],
    );
    seeded.push(name);
  }
  console.log(
    `${logPrefix} Seeded ${seeded.length}/${pairs.length} wallets` +
      (skipped.length ? `; skipped: ${skipped.join(", ")}` : "."),
  );
  try {
    const alerts = await client.channels.fetch(VERIFIERS_ALERTS_CHANNEL_ID).catch(() => null);
    if (alerts) {
      await alerts.send({
        content:
          `💳 Wallet seed: stored **${seeded.length}/${pairs.length}** known whitelisted wallets. ` +
          (skipped.length
            ? `Could not match: ${skipped.join(", ")} — set those manually in the dashboard.`
            : `All usernames matched.`) +
          ` The on-chain sync will mark them Whitelisted automatically.`,
      });
    }
  } catch (err) {
    console.warn(`${logPrefix} Could not announce the seed:`, err.message);
  }
}

// Called once per watcher cycle; every task dedupes itself via settings.
async function runScheduledTasks(client) {
  if (!db.isEnabled()) return;
  const settings = await db.getSettings();
  try {
    await maybeSeedInitialWallets(client, settings);
  } catch (err) {
    console.error(`${logPrefix} Wallet seed failed:`, err.message);
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (settings.whitelist_sync_date !== today || settings.wallet_seed_done !== "1") {
      await db.setSetting("whitelist_sync_date", today);
      await syncWhitelistFlags();
    }
  } catch (err) {
    console.error(`${logPrefix} On-chain sync failed:`, err.message);
  }
  try {
    await maybeMonthlyReminder(client, settings);
  } catch (err) {
    console.error(`${logPrefix} Monthly reminder failed:`, err.message);
  }
}

module.exports = {
  fetchOnchainWhitelist,
  syncWhitelistFlags,
  getQualifiedUsers,
  getWhitelistBatch,
  runScheduledTasks,
};
