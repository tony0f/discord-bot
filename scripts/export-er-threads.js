// Export every ER (dispute) thread from #dispute-threads to JSONL for LLM
// analysis. Standalone REST script — run locally, NOT inside the bot:
//
//   node scripts/export-er-threads.js [--out er-threads.jsonl]
//     [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--refresh-days N]
//     [--markdown <dir>] [--max-messages N]
//
// Resumable by design: threads already present in the output file are
// skipped, so re-running continues where it left off. With --refresh-days N,
// threads archived/created in the last N days are re-exported (appended);
// dedupe downstream by thread_id keeping the LAST occurrence.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISPUTE_THREADS_CHANNEL_ID || "964000735073284127";
const GUILD_ID = process.env.UMA_GUILD_ID || "718590743446290492";
const API = "https://discord.com/api/v10";

if (!TOKEN) {
  console.error("DISCORD_TOKEN missing in .env");
  process.exit(1);
}

// ---- args ----
const args = process.argv.slice(2);
function argValue(name, fallback = null) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const OUT_FILE = path.resolve(argValue("--out", "er-threads.jsonl"));
const SINCE = argValue("--since") ? Date.parse(argValue("--since") + "T00:00:00Z") : null;
const UNTIL = argValue("--until") ? Date.parse(argValue("--until") + "T23:59:59Z") : null;
const REFRESH_DAYS = parseInt(argValue("--refresh-days", "0"), 10) || 0;
const MARKDOWN_DIR = argValue("--markdown") ? path.resolve(argValue("--markdown")) : null;
const MAX_MESSAGES = parseInt(argValue("--max-messages", "2000"), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Discord REST with rate-limit handling ----
async function discordGet(endpoint) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`${API}${endpoint}`, {
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "User-Agent": "DiscordBot (https://uma.xyz, UMABot er-export/1.0)",
      },
    });
    if (res.status === 429) {
      const wait = (parseFloat(res.headers.get("x-ratelimit-reset-after")) || 2 ** attempt) * 1000;
      console.warn(`  rate limited, waiting ${Math.round(wait)}ms…`);
      await sleep(wait + 100);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Discord ${res.status} at ${endpoint}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error(`Rate limited beyond retries at ${endpoint}`);
}

// ---- thread enumeration: active + full archived walk ----
async function enumerateThreads() {
  const byId = new Map();

  const active = await discordGet(`/guilds/${GUILD_ID}/threads/active`);
  for (const t of active.threads || []) {
    if (t.parent_id === CHANNEL_ID) byId.set(t.id, t);
  }
  console.log(`active threads in channel: ${byId.size}`);

  let before = null;
  let pages = 0;
  for (;;) {
    const qs = new URLSearchParams({ limit: "100" });
    if (before) qs.set("before", before);
    const batch = await discordGet(`/channels/${CHANNEL_ID}/threads/archived/public?${qs}`);
    const threads = batch.threads || [];
    for (const t of threads) byId.set(t.id, t);
    pages++;
    if (pages % 10 === 0) console.log(`  archived pages: ${pages} (${byId.size} threads so far)`);
    if (!batch.has_more || threads.length === 0) break;
    const oldest = threads[threads.length - 1];
    before = oldest.thread_metadata?.archive_timestamp;
    if (!before) break;
    // Archive time >= creation time: once archives predate --since, stop
    if (SINCE && Date.parse(before) < SINCE) break;
    await sleep(120);
  }
  console.log(`enumeration done: ${byId.size} threads (${pages} archived pages)`);
  return [...byId.values()];
}

// ---- message fetching ----
function slimMessage(m) {
  const embedUrls = [];
  for (const e of m.embeds || []) {
    for (const u of [e.url, e.image?.url, e.video?.url, e.thumbnail?.url]) {
      if (u && !embedUrls.includes(u)) embedUrls.push(u);
    }
  }
  return {
    id: m.id,
    author: m.member?.nick || m.author?.global_name || m.author?.username || "unknown",
    author_id: m.author?.id || null,
    bot: !!m.author?.bot,
    timestamp: m.timestamp,
    content: m.content || "",
    attachments: (m.attachments || []).map((a) => a.url),
    embed_urls: embedUrls,
    reply_to: m.message_reference?.message_id || null,
  };
}

async function fetchThreadMessages(threadId) {
  const all = [];
  let before = null;
  while (all.length < MAX_MESSAGES) {
    const qs = new URLSearchParams({ limit: "100" });
    if (before) qs.set("before", before);
    const batch = await discordGet(`/channels/${threadId}/messages?${qs}`);
    if (batch.length === 0) break;
    all.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
    await sleep(120);
  }
  return all.reverse().map(slimMessage); // chronological
}

// ---- thread-name metadata (title + on-chain request timestamp) ----
function parseThreadName(name) {
  const match = /^(.*?)\s*[–—-]\s*(\d{9,12})$/.exec(name || "");
  if (!match) return { title: name || "", request_timestamp: null };
  return { title: match[1].trim(), request_timestamp: parseInt(match[2], 10) };
}

// ---- resumability: ids already in the output file ----
async function loadExportedIds() {
  const ids = new Set();
  if (!fs.existsSync(OUT_FILE)) return ids;
  const rl = readline.createInterface({ input: fs.createReadStream(OUT_FILE) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      ids.add(JSON.parse(line).thread_id);
    } catch {
      /* partial last line from an interrupted run — it will be re-exported */
    }
  }
  return ids;
}

function toMarkdown(record) {
  const lines = [`# ${record.name}`, "", `Created: ${record.created_at} · [Thread](${record.url})`, ""];
  for (const m of record.messages) {
    lines.push(`**${m.author}**${m.bot ? " [bot]" : ""} (${m.timestamp}):`);
    if (m.content) lines.push(...m.content.split("\n").map((l) => `> ${l}`));
    for (const u of [...m.attachments, ...m.embed_urls]) lines.push(`> 📎 ${u}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---- main ----
(async () => {
  console.log(`output: ${OUT_FILE}`);
  const exported = await loadExportedIds();
  console.log(`already exported: ${exported.size} threads (will be skipped)`);

  const refreshCutoff = REFRESH_DAYS > 0 ? Date.now() - REFRESH_DAYS * 86400000 : null;
  const threads = await enumerateThreads();

  const todo = threads
    .filter((t) => {
      const created = Date.parse(t.thread_metadata?.create_timestamp || 0) || snowflakeMs(t.id);
      if (SINCE && created < SINCE) return false;
      if (UNTIL && created > UNTIL) return false;
      if (!exported.has(t.id)) return true;
      if (!refreshCutoff) return false;
      const archived = Date.parse(t.thread_metadata?.archive_timestamp || 0) || 0;
      return archived > refreshCutoff || created > refreshCutoff;
    })
    .sort((a, b) => snowflakeMs(a.id) - snowflakeMs(b.id));

  console.log(`to export: ${todo.length} threads\n`);
  if (MARKDOWN_DIR) fs.mkdirSync(MARKDOWN_DIR, { recursive: true });

  const out = fs.createWriteStream(OUT_FILE, { flags: "a" });
  let done = 0;
  let totalMessages = 0;
  for (const t of todo) {
    try {
      const messages = await fetchThreadMessages(t.id);
      const { title, request_timestamp } = parseThreadName(t.name);
      const record = {
        thread_id: t.id,
        name: t.name,
        title,
        request_timestamp,
        created_at: new Date(snowflakeMs(t.id)).toISOString(),
        archived_at: t.thread_metadata?.archive_timestamp || null,
        url: `https://discord.com/channels/${GUILD_ID}/${t.id}`,
        message_count: messages.length,
        messages,
      };
      out.write(JSON.stringify(record) + "\n");
      if (MARKDOWN_DIR) {
        fs.writeFileSync(path.join(MARKDOWN_DIR, `${t.id}.md`), toMarkdown(record));
      }
      done++;
      totalMessages += messages.length;
      if (done % 25 === 0 || done === todo.length) {
        console.log(`[${done}/${todo.length}] last: ${t.name.slice(0, 70)}`);
      }
      await sleep(120);
    } catch (err) {
      console.error(`FAILED thread ${t.id} (${t.name}): ${err.message} — re-run to retry.`);
    }
  }
  out.end();

  const sizeMb = (fs.statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
  console.log(`\ndone: ${done} threads exported this run, ${totalMessages} messages, file ${sizeMb} MB`);
})();

function snowflakeMs(id) {
  return Number(BigInt(id) >> 22n) + 1420070400000;
}
