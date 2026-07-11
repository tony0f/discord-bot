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

function buildRequestEmbed(request, { creditWindowHours } = {}) {
  const display = STATUS_DISPLAY[request.status] || STATUS_DISPLAY.pending;
  const isActive = request.status === "pending" || request.status === "proposed";
  // A community warning visually takes over the card while the request is active
  const color = request.flag_reason && isActive ? 0xe74c3c : display.color;

  const embed = new EmbedBuilder()
    .setTitle(truncate(request.market_question, 256))
    .setURL(request.market_url)
    .setColor(color)
    .setTimestamp(new Date(request.created_at));

  if (request.flag_reason) {
    embed.addFields({
      name: "🚩 COMMUNITY WARNING",
      value: truncate(
        `Reported by <@${request.flagged_by}> (**${request.flagged_by_username}**):\n> ${request.flag_reason}\n*Under admin review — proposers, be extra careful.*`,
        1024,
      ),
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
      value: truncate(request.evidence, 1024),
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
  if (request.early_claim) {
    embed.addFields({
      name: "⚠️ Early resolution",
      value:
        "The market's scheduled end time has not passed. Per the rules it **can** be proposed as soon as the event has occurred — but only then. Verify the evidence carefully (DYOR).",
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

function buildDashboardEmbed(requests, { creditWindowHours }) {
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
    const badges = [
      r.flag_reason ? "🚩" : "",
      r.early_claim ? "⚠️" : "",
    ].filter(Boolean).join(" ");

    const evidenceUrls = (r.evidence || "").match(/https?:\/\/[^\s<>()'"]+/g) || [];
    const evidenceLine =
      evidenceUrls.length > 0
        ? `${evidenceUrls[0]}${evidenceUrls.length > 1 ? ` *(+${evidenceUrls.length - 1} more in the card)*` : ""}`
        : truncate(r.evidence, 150);

    const lines = [
      `${statusEmoji} **#${r.id} — [${truncate(r.market_question, 90)}](${r.market_url})** ${badges}`.trimEnd(),
      `> **Propose as:** ${r.requested_outcome}`,
      `> **Requested by:** <@${r.discord_user_id}>`,
      `> 📎 **Evidence:** ${truncate(evidenceLine, 220)}`,
    ];
    if (r.early_claim) {
      lines.push("> ⚠️ *Early resolution — proposable only once the event has occurred*");
    }
    if (r.flag_reason) {
      lines.push(`> 🚩 **Community warning** by ${r.flagged_by_username}: *${truncate(r.flag_reason, 120)}*`);
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
