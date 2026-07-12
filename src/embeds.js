const { EmbedBuilder } = require("discord.js");

const STATUS_DISPLAY = {
  pending: { emoji: "⏳", label: "Pending proposal", color: 0xf1c40f },
  proposed: { emoji: "📤", label: "Proposed on-chain", color: 0x3498db },
  settled_correct: { emoji: "✅", label: "Settled as requested — credited", color: 0x2ecc71 },
  settled_incorrect: { emoji: "❌", label: "Settled against the request", color: 0xe74c3c },
  expired: { emoji: "🕒", label: "Expired — no proposal within the window", color: 0x95a5a6 },
  invalidated: { emoji: "🚫", label: "Invalidated by an admin", color: 0x7f8c8d },
};

function truncate(text, max) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function unixSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function buildRequestEmbed(request, { creditWindowHours, reports = [] } = {}) {
  const display = STATUS_DISPLAY[request.status] || STATUS_DISPLAY.pending;
  const isActive = request.status === "pending" || request.status === "proposed";
  // Community warnings visually take over the card while the request is active
  const color = reports.length > 0 && isActive ? 0xe74c3c : display.color;

  const embed = new EmbedBuilder()
    .setTitle(
      truncate(
        `${reports.length > 0 ? "🚩 " : ""}${request.market_question}`,
        256,
      ),
    )
    .setURL(request.market_url)
    .setColor(color)
    .setTimestamp(new Date(request.created_at));

  if (reports.length > 0) {
    const listed = reports
      .slice(0, 5)
      .map(
        (rep, i) =>
          `> **${i + 1}. ${rep.reporter_username}** (<t:${unixSeconds(rep.created_at)}:R>): ${truncate(rep.reason, 150)}`,
      );
    let value =
      `‼️ **PROPOSERS BEWARE — verify everything before proposing** ‼️\n${listed.join("\n")}`;
    if (reports.length > 5) {
      value += `\n> *…and ${reports.length - 5} more.*`;
    }
    value += "\n*Under admin review.*";
    embed.addFields({
      name: `🚨 COMMUNITY WARNINGS (${reports.length}) 🚨`,
      value: truncate(value, 1024),
    });
  }

  embed.addFields(
    {
      name: "Propose as",
      value: `**${request.requested_outcome}**`,
      inline: true,
    },
    {
      name: "Requested by",
      value: `<@${request.discord_user_id}>`,
      inline: true,
    },
    {
      name: "Status",
      value: `${display.emoji} ${display.label}`,
      inline: true,
    },
    {
      name: "Evidence",
      value: request.evidence
        ? truncate(request.evidence, 250) +
          (request.evidence.length > 250 ? "\n*(full evidence posted below ⤵️)*" : "")
        : "*None provided*",
    },
  );

  embed.setFooter({
    text: `Request #${request.id}${creditWindowHours ? ` • credit window: ${creditWindowHours}h` : ""} • DYOR before proposing`,
  });

  if (request.end_date) {
    embed.addFields({
      name: "Market end date",
      value: `<t:${unixSeconds(request.end_date)}:f> (<t:${unixSeconds(request.end_date)}:R>)`,
      inline: true,
    });
  }
  if (request.status === "settled_correct" || request.status === "settled_incorrect") {
    embed.addFields({
      name: "Settled outcome",
      value: `**${request.settled_outcome || "?"}**`,
      inline: true,
    });
  }
  if (request.status === "invalidated" && request.invalidated_reason) {
    embed.addFields({
      name: "Invalidation reason",
      value: truncate(request.invalidated_reason, 1024),
    });
  }

  return embed;
}

function buildDashboardEmbed(requests, { creditWindowHours, reportsMap = {} }) {
  const embed = new EmbedBuilder()
    .setTitle("📋 Proposal Requests — Live Board")
    .setColor(0x9b59b6)
    .setTimestamp(new Date());

  const dyorNotice =
    "🔍 **DYOR** — Proposers: verify every claim, its evidence and the market rules yourself before proposing.";

  if (requests.length === 0) {
    embed.setDescription(`${dyorNotice}\n\nNo active requests right now. Use \`/request\` to add one.`);
    return embed;
  }

  const blocks = [];
  for (const r of requests.slice(0, 15)) {
    const statusEmoji = r.status === "proposed" ? "📤" : "⏳";
    const reports = reportsMap[r.id] || [];
    const badges =
      reports.length > 0 ? `🚩${reports.length > 1 ? `×${reports.length}` : ""}` : "";

    const lines = [
      `${statusEmoji} **#${r.id} — [${truncate(r.market_question, 90)}](${r.market_url})** ${badges}`.trimEnd(),
      `> **Propose as:** ${r.requested_outcome}`,
      `> **Requested by:** <@${r.discord_user_id}>`,
    ];
    if (r.evidence) {
      const evidenceUrls = r.evidence.match(/https?:\/\/[^\s<>()'"]+/g) || [];
      const evidenceLine =
        evidenceUrls.length > 0
          ? `${evidenceUrls[0]}${evidenceUrls.length > 1 ? ` *(+${evidenceUrls.length - 1} more in the card)*` : ""}`
          : truncate(r.evidence, 150);
      lines.push(`> 📎 **Evidence:** ${truncate(evidenceLine, 220)}`);
    }
    if (reports.length > 0) {
      lines.push(
        `> 🚨 **${reports.length} COMMUNITY WARNING${reports.length > 1 ? "S" : ""} — proposers beware:**`,
      );
      for (const rep of reports.slice(0, 3)) {
        lines.push(`> ‣ **${rep.reporter_username}**: *${truncate(rep.reason, 100)}*`);
      }
      if (reports.length > 3) {
        lines.push(`> ‣ *…and ${reports.length - 3} more (see the card)*`);
      }
    }
    if (r.status === "pending") {
      const expiresAt = unixSeconds(
        new Date(new Date(r.created_at).getTime() + creditWindowHours * 3600 * 1000),
      );
      lines.push(`> ⏱️ Expires <t:${expiresAt}:R>`);
    } else {
      lines.push("> 📤 Proposed — awaiting settlement");
    }
    blocks.push(lines.join("\n"));
  }

  let description = `${dyorNotice}\n\n${blocks.join("\n\n")}`;
  if (requests.length > 15) {
    description += `\n\n*…and ${requests.length - 15} more.*`;
  }
  embed.setDescription(truncate(description, 4096));
  embed.setFooter({
    text: `${requests.length} active request(s) • credit window: ${creditWindowHours}h • DYOR`,
  });
  return embed;
}

module.exports = { buildRequestEmbed, buildDashboardEmbed, STATUS_DISPLAY };
