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

  const embed = new EmbedBuilder()
    .setTitle(truncate(request.market_question, 256))
    .setURL(request.market_url)
    .setColor(display.color)
    .addFields(
      {
        name: "Requested outcome",
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
    )
    .setFooter({
      text: `Request #${request.id}${creditWindowHours ? ` • credit window: ${creditWindowHours}h` : ""}`,
    })
    .setTimestamp(new Date(request.created_at));

  if (request.end_date) {
    embed.addFields({
      name: "Market end date",
      value: `<t:${unixSeconds(request.end_date)}:f> (<t:${unixSeconds(request.end_date)}:R>)`,
      inline: true,
    });
  }
  if (request.early_claim) {
    embed.addFields({
      name: "⚠️ Early resolution claim",
      value: "The market's scheduled end time has not passed yet. Proposers: verify the evidence carefully before proposing.",
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
    .setTitle("📋 Proposal Requests — live board")
    .setColor(0x9b59b6)
    .setTimestamp(new Date());

  if (requests.length === 0) {
    embed.setDescription("No active requests right now. Use `/request` to add one.");
    return embed;
  }

  const lines = [];
  for (const r of requests.slice(0, 20)) {
    const statusEmoji = r.status === "proposed" ? "📤" : "⏳";
    const expiresAt = unixSeconds(
      new Date(new Date(r.created_at).getTime() + creditWindowHours * 3600 * 1000),
    );
    const early = r.early_claim ? " ⚠️" : "";
    const timing =
      r.status === "pending" ? ` • expires <t:${expiresAt}:R>` : " • awaiting settlement";
    lines.push(
      `${statusEmoji} **#${r.id}** [${truncate(r.market_question, 80)}](${r.market_url})\n` +
        `   → **${r.requested_outcome}** • by <@${r.discord_user_id}>${early}${timing}`,
    );
  }

  let description = lines.join("\n");
  if (requests.length > 20) {
    description += `\n\n*…and ${requests.length - 20} more.*`;
  }
  embed.setDescription(truncate(description, 4096));
  embed.setFooter({
    text: `${requests.length} active request(s) • credit window: ${creditWindowHours}h`,
  });
  return embed;
}

module.exports = { buildRequestEmbed, buildDashboardEmbed, STATUS_DISPLAY };
