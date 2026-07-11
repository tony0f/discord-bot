const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");
const db = require("./db");
const pr = require("./proposalRequests");
const { buildRequestEmbed } = require("./embeds");
const { refreshDashboard } = require("./watcher");
const {
  PROPOSAL_REQUESTS_CHANNEL_ID,
  RISK_LABS_ROLE_ID,
  QUALIFY_MIN_SETTLED,
  QUALIFY_MIN_ACCURACY,
} = require("./config");

const REQUEST_MODAL_ID = "proposal_request_modal";

function hasAccess(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.roles.cache.has(RISK_LABS_ROLE_ID)
  );
}

function dbDisabledReply(interaction) {
  return interaction.reply({
    content: "⚠️ The proposal-requests system is not available: the database is not configured.",
    flags: MessageFlags.Ephemeral,
  });
}

function buildRequestModal() {
  const modal = new ModalBuilder()
    .setCustomId(REQUEST_MODAL_ID)
    .setTitle("Request a market proposal");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("market_link")
        .setLabel("Polymarket link")
        .setPlaceholder("https://polymarket.com/event/...")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(400)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("outcome")
        .setLabel("Proposed outcome")
        .setPlaceholder('e.g. "Yes", "No", a team name, or "50-50"')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("evidence")
        .setLabel("Evidence (must include at least one link)")
        .setPlaceholder("Sources, articles, official pages proving the outcome…")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("wallet")
        .setLabel("Your wallet address (optional)")
        .setPlaceholder("0x… — needed later for whitelist inclusion")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(50)
        .setRequired(false),
    ),
  );
  return modal;
}

async function handleRequestModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const marketUrl = interaction.fields.getTextInputValue("market_link");
  const outcomeInput = interaction.fields.getTextInputValue("outcome");
  const evidence = interaction.fields.getTextInputValue("evidence");
  const wallet = interaction.fields.getTextInputValue("wallet") || null;

  const result = await pr.createRequest({
    user: interaction.user,
    displayName: interaction.member?.displayName,
    marketUrl,
    outcomeInput,
    evidence,
    wallet,
  });

  if (!result.ok) {
    return interaction.editReply({ content: `❌ ${result.error}` });
  }

  const settings = await db.getSettings();
  const creditWindowHours = parseInt(settings.credit_window_hours, 10);
  const request = result.request;

  // Publish the request card in the proposal-requests channel with a
  // discussion thread, mirroring the existing human workflow.
  try {
    const channel = await interaction.client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
    const message = await channel.send({
      embeds: [buildRequestEmbed(request, { creditWindowHours })],
    });
    await pr.setRequestMessage(request.id, channel.id, message.id);
    try {
      await message.startThread({
        name: `#${request.id} ${request.market_question}`.slice(0, 100),
      });
    } catch (threadErr) {
      console.warn(`[PR] Could not create discussion thread for request #${request.id}:`, threadErr.message);
    }
  } catch (err) {
    console.error(`[PR] Could not publish request #${request.id} to channel:`, err.message);
  }

  refreshDashboard(interaction.client).catch(() => {});

  return interaction.editReply({
    content:
      `✅ Request **#${request.id}** registered: **${request.market_question}** → **${request.requested_outcome}**.\n` +
      `A whitelisted proposer must propose it within **${creditWindowHours}h** and the market must settle as you requested for it to count toward your record.` +
      (request.early_claim
        ? "\n⚠️ Note: the market's end time has not passed yet, so it was flagged as an *early resolution claim*."
        : ""),
  });
}

async function handleMyStats(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const stats = await pr.getUserStats(interaction.user.id);

  const accuracyText =
    stats.accuracy6m === null ? "—" : `${(stats.accuracy6m * 100).toFixed(1)}%`;

  const embed = new EmbedBuilder()
    .setTitle(`📊 Proposal-request stats — ${interaction.member?.displayName || interaction.user.username}`)
    .setColor(stats.qualified ? 0x2ecc71 : 0x3498db)
    .addFields(
      { name: "Active (pending/proposed)", value: `${stats.active}`, inline: true },
      { name: "Settled correct (6m)", value: `${stats.correct6m}`, inline: true },
      { name: "Settled incorrect (6m)", value: `${stats.incorrect6m}`, inline: true },
      { name: "Accuracy (6m)", value: accuracyText, inline: true },
      { name: "Expired (no proposal)", value: `${stats.expired}`, inline: true },
      { name: "Total requests", value: `${stats.total}`, inline: true },
      {
        name: "Whitelist criteria",
        value: stats.qualified
          ? "🎓 **You meet the criteria!** Contact an admin to review your inclusion."
          : `Progress: **${stats.settled6m}/${QUALIFY_MIN_SETTLED}** settled requests with ≥${QUALIFY_MIN_ACCURACY * 100}% accuracy in the last 6 months.`,
      },
    );
  return interaction.editReply({ embeds: [embed] });
}

async function handleLeaderboard(interaction) {
  await interaction.deferReply();
  const rows = await pr.getLeaderboard(15);

  if (rows.length === 0) {
    return interaction.editReply({
      content: "No settled requests in the last 6 months yet. Be the first with `/request`!",
    });
  }

  const lines = rows.map((r, i) => {
    const medal = ["🥇", "🥈", "🥉"][i] || `**${i + 1}.**`;
    const qualified =
      r.settled >= QUALIFY_MIN_SETTLED && r.accuracy >= QUALIFY_MIN_ACCURACY ? " 🎓" : "";
    return `${medal} **${r.username}** — ${r.correct}✅ / ${r.incorrect}❌ (${(r.accuracy * 100).toFixed(1)}%)${qualified}`;
  });

  const embed = new EmbedBuilder()
    .setTitle("🏆 Proposal Requests — leaderboard (last 6 months)")
    .setColor(0xf39c12)
    .setDescription(lines.join("\n"))
    .setFooter({
      text: `🎓 = meets whitelist criteria (${QUALIFY_MIN_SETTLED}+ settled, ≥${QUALIFY_MIN_ACCURACY * 100}% accuracy)`,
    })
    .setTimestamp(new Date());
  return interaction.editReply({ embeds: [embed] });
}

async function handleAdmin(interaction) {
  if (!hasAccess(interaction.member)) {
    return interaction.reply({
      content: "⛔ This command requires Administrator permissions or the Risk Labs role.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "view_settings") {
    const settings = await db.getSettings();
    return interaction.reply({
      content:
        `**Proposal-requests settings**\n` +
        `- Credit window: **${settings.credit_window_hours}h**\n` +
        `- Max active requests per user: **${settings.max_active_per_user}**\n` +
        `- Daily request limit per user: **${settings.daily_request_limit}**\n` +
        `- Watcher poll interval: **${settings.poll_interval_minutes} min**\n` +
        `- Dashboard channel: ${settings.dashboard_channel_id ? `<#${settings.dashboard_channel_id}>` : "*not set*"}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === "set_credit_window") {
    const hours = interaction.options.getInteger("hours");
    await db.setSetting("credit_window_hours", hours);
    return interaction.reply({
      content: `✅ Credit window set to **${hours}h**. Applies to expiry checks from now on.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === "set_max_active") {
    const value = interaction.options.getInteger("value");
    await db.setSetting("max_active_per_user", value);
    return interaction.reply({
      content: `✅ Max active requests per user set to **${value}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === "set_daily_limit") {
    const value = interaction.options.getInteger("value");
    await db.setSetting("daily_request_limit", value);
    return interaction.reply({
      content: `✅ Daily request limit per user set to **${value}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === "set_poll_interval") {
    const minutes = interaction.options.getInteger("minutes");
    await db.setSetting("poll_interval_minutes", minutes);
    return interaction.reply({
      content: `✅ Watcher poll interval set to **${minutes} min** (applies after the current cycle).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === "set_dashboard_channel") {
    const channel = interaction.options.getChannel("channel");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await db.setSetting("dashboard_channel_id", channel.id);
    await db.setSetting("dashboard_message_id", "");
    await refreshDashboard(interaction.client);
    return interaction.editReply({
      content: `✅ Live board created in <#${channel.id}>. It refreshes on every watcher cycle.`,
    });
  }

  if (sub === "invalidate") {
    const id = interaction.options.getInteger("id");
    const reason = interaction.options.getString("reason");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const request = await pr.getRequestById(id);
    if (!request) {
      return interaction.editReply({ content: `❌ Request #${id} not found.` });
    }
    if (["settled_correct", "settled_incorrect"].includes(request.status)) {
      return interaction.editReply({
        content: `⚠️ Request #${id} is already settled (\`${request.status}\`). Invalidating it anyway would rewrite history — not allowed.`,
      });
    }

    const updated = await pr.invalidateRequest(id, reason);
    const { editRequestMessage } = require("./watcher");
    await editRequestMessage(interaction.client, updated).catch(() => {});
    refreshDashboard(interaction.client).catch(() => {});
    return interaction.editReply({
      content: `✅ Request #${id} invalidated. Reason: ${reason}`,
    });
  }

  if (sub === "user_stats") {
    const user = interaction.options.getUser("user");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stats = await pr.getUserStats(user.id);
    const accuracyText =
      stats.accuracy6m === null ? "—" : `${(stats.accuracy6m * 100).toFixed(1)}%`;
    return interaction.editReply({
      content:
        `**Stats for ${user.tag}** (<@${user.id}>)\n` +
        `- Active: **${stats.active}** • Expired: **${stats.expired}** • Total: **${stats.total}**\n` +
        `- Last 6 months: **${stats.correct6m}✅ / ${stats.incorrect6m}❌** — accuracy **${accuracyText}**\n` +
        `- Meets whitelist criteria: **${stats.qualified ? "YES 🎓" : "no"}**`,
    });
  }

  return interaction.reply({
    content: "Unknown subcommand.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (!interaction.inGuild()) return;
      const { commandName } = interaction;

      if (commandName === "request") {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return interaction.showModal(buildRequestModal());
      }
      if (commandName === "mystats") {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleMyStats(interaction);
      }
      if (commandName === "leaderboard") {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleLeaderboard(interaction);
      }
      if (commandName === "pr-admin") {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleAdmin(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === REQUEST_MODAL_ID) {
      if (!db.isEnabled()) return dbDisabledReply(interaction);
      return handleRequestModalSubmit(interaction);
    }
  } catch (err) {
    console.error("[Interactions] Unhandled error:", err);
    const payload = {
      content: "❌ An unexpected error occurred. Please try again or contact an admin.",
      flags: MessageFlags.Ephemeral,
    };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch {
      /* interaction already gone */
    }
  }
}

module.exports = { handleInteraction };
