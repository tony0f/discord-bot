// Search ER (dispute) threads by title and date range, and export every user
// comment (with attachment/embed links) as downloadable markdown.
const { DISPUTE_THREADS_CHANNEL_ID } = require("./config");

const MAX_ARCHIVED_PAGES = 25; // 25 × 100 threads
const MAX_MESSAGES_PER_THREAD = 500;
const MAX_THREADS = 40;

function parseDay(input, endOfDay = false) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(input || "").trim());
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(ms)) return null;
  return endOfDay ? ms + 24 * 60 * 60 * 1000 - 1 : ms;
}

async function collectThreads(channel, fromMs, toMs, queryLower) {
  const matches = new Map();
  const consider = (thread) => {
    if (!thread?.createdTimestamp) return;
    if (thread.createdTimestamp < fromMs || thread.createdTimestamp > toMs) return;
    if (!thread.name.toLowerCase().includes(queryLower)) return;
    matches.set(thread.id, thread);
  };

  const active = await channel.threads.fetchActive();
  active.threads.forEach(consider);

  let before;
  for (let page = 0; page < MAX_ARCHIVED_PAGES; page++) {
    const batch = await channel.threads.fetchArchived({ before, limit: 100 });
    batch.threads.forEach(consider);
    if (!batch.hasMore || batch.threads.size === 0) break;
    const oldest = [...batch.threads.values()].at(-1);
    before = oldest.archiveTimestamp ?? undefined;
    // Archive time >= creation time, so once archives predate the range
    // nothing older can match
    if ((oldest.archiveTimestamp ?? 0) < fromMs) break;
  }

  return [...matches.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function fetchThreadMessages(thread) {
  const all = [];
  let before;
  while (all.length < MAX_MESSAGES_PER_THREAD) {
    const batch = await thread.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function formatTime(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function messageLinks(message) {
  const links = [];
  for (const attachment of message.attachments.values()) {
    links.push(attachment.url);
  }
  for (const embed of message.embeds) {
    for (const url of [embed.url, embed.image?.url, embed.video?.url, embed.thumbnail?.url]) {
      if (url && !links.includes(url)) links.push(url);
    }
  }
  return links;
}

// Returns { markdown, threadCount, commentCount, truncated }
async function searchToMarkdown(client, { query, fromMs, toMs }) {
  const channel = await client.channels.fetch(DISPUTE_THREADS_CHANNEL_ID);
  const queryLower = query.toLowerCase();

  let threads = await collectThreads(channel, fromMs, toMs, queryLower);
  const truncated = threads.length > MAX_THREADS;
  if (truncated) threads = threads.slice(0, MAX_THREADS);

  const lines = [
    `# ER Threads search`,
    ``,
    `- **Query:** \`${query}\``,
    `- **Range:** ${formatTime(fromMs).slice(0, 10)} → ${formatTime(toMs).slice(0, 10)} (UTC, by thread creation)`,
    `- **Generated:** ${formatTime(Date.now())}`,
    `- **Threads found:** ${threads.length}${truncated ? ` (capped at ${MAX_THREADS})` : ""}`,
    ``,
  ];

  let commentCount = 0;
  for (const thread of threads) {
    const messages = await fetchThreadMessages(thread);
    const userMessages = messages.filter((m) => !m.author.bot);

    lines.push(`---`, ``);
    lines.push(`## ${thread.name}`);
    lines.push(``);
    lines.push(
      `Created: ${formatTime(thread.createdTimestamp)} · ${userMessages.length} user comment(s) · [Open thread](${thread.url})`,
    );
    lines.push(``);

    if (userMessages.length === 0) {
      lines.push(`*No user comments.*`, ``);
      continue;
    }

    for (const message of userMessages) {
      commentCount++;
      const author = message.member?.displayName || message.author.username;
      const content = (message.content || "").trim().replace(/\r?\n/g, "\n  > ");
      lines.push(`- **${author}** (${formatTime(message.createdTimestamp)}):`);
      if (content) lines.push(`  > ${content}`);
      for (const url of messageLinks(message)) {
        lines.push(`  > 📎 ${url}`);
      }
      lines.push(``);
    }
  }

  if (threads.length === 0) {
    lines.push(`*No threads matched.*`);
  }

  return {
    markdown: lines.join("\n"),
    threadCount: threads.length,
    commentCount,
    truncated,
  };
}

module.exports = { searchToMarkdown, parseDay };
