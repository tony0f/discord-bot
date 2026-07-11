const {
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");
const db = require("./db");
const pm = require("./polymarket");
const pr = require("./proposalRequests");
const { buildRequestEmbed } = require("./embeds");
const { refreshDashboard } = require("./watcher");
const {
  PROPOSAL_REQUESTS_CHANNEL_ID,
  RISK_LABS_ROLE_ID,
  ADMIN_USER_IDS,
  QUALIFY_MIN_SETTLED,
  QUALIFY_MIN_ACCURACY,
} = require("./config");

const REQUEST_MODAL_PREFIX = "prq:";

// Context captured when /request is invoked, consumed on modal submit.
// Keyed by the command interaction id (embedded in the modal customId).
const pendingForms = new Map();
const FORM_TTL_MS = 15 * 60 * 1000;

function pruneForms() {
  const now = Date.now();
  for (const [key, form] of pendingForms) {
    if (now - form.createdAt > FORM_TTL_MS) pendingForms.delete(key);
  }
}

function truncate(text, max) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function hasAccess(member) {
  return (
    ADMIN_USER_IDS.includes(member.id) ||
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Builds the dynamic modal from the resolved link:
// - event with brackets  → multi-select of brackets + Yes/No/50-50 select
// - single market        → select with its real outcomes
function buildRequestModal(interactionId, form, maxSelectable) {
  const modal = new ModalBuilder()
    .setCustomId(`${REQUEST_MODAL_PREFIX}${interactionId}`)
    .setTitle("Request a market proposal");

  let outcomeOptions;

  if (form.type === "event") {
    const options = form.brackets.slice(0, 25).map((b) => ({
      label: truncate(b.title, 100),
      value: b.slug,
      description: truncate(b.question, 100),
    }));
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel("Market bracket(s)")
        .setDescription(truncate(`From: ${form.eventTitle}`, 100))
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("market")
            .setMinValues(1)
            .setMaxValues(Math.min(maxSelectable, options.length))
            .addOptions(options),
        ),
    );
    // Brackets are binary Yes/No markets
    outcomeOptions = ["Yes", "No", pm.TIE_OUTCOME];
  } else {
    outcomeOptions = [...pm.getOutcomes(form.market), pm.TIE_OUTCOME];
  }

  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel("Proposed outcome")
      .setDescription(
        form.type === "event"
          ? "Applies to every selected bracket"
          : truncate(form.market.question, 100),
      )
      .setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId("outcome")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            outcomeOptions.slice(0, 25).map((o) => ({
              label: truncate(o, 100),
              value: truncate(o, 100),
            })),
          ),
      ),
    new LabelBuilder()
      .setLabel("Evidence (must include a link)")
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId("evidence")
          .setPlaceholder("Sources proving the outcome, e.g. an X post, article, official page…")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true),
      ),
    new LabelBuilder()
      .setLabel("Your wallet address (optional)")
      .setTextInputComponent(
        new TextInputBuilder()
          .setCustomId("wallet")
          .setPlaceholder("0x… — needed later for whitelist inclusion")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(false),
      ),
  );

  return modal;
}

async function handleRequestCommand(interaction) {
  // Everything here must finish within Discord's 3s window (showModal cannot
  // be deferred), so the Gamma lookup runs with a hard timeout.
  const link = interaction.options.getString("link");

  const settings = await db.getSettings();
  const stats = await pr.getUserStats(interaction.user.id);

  if (stats.qualified) {
    return interaction.reply({
      content:
        `🎓 You already meet the whitelist criteria (**${stats.settled6m} settled**, **${(stats.accuracy6m * 100).toFixed(1)}%** accuracy). ` +
        `New requests are closed for you — contact an admin to review your inclusion.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const maxActive = parseInt(settings.max_active_per_user, 10);
  if (stats.active >= maxActive) {
    return interaction.reply({
      content: `❌ You already have **${stats.active} active requests** (max ${maxActive}). Wait until some are proposed or expire.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const dailyLimit = parseInt(settings.daily_request_limit, 10);
  if (stats.last24h >= dailyLimit) {
    return interaction.reply({
      content: `❌ You reached the limit of **${dailyLimit} requests per 24h**. Try again later.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  let form;
  try {
    form = await withTimeout(pm.resolveLinkForForm(link), 2200);
  } catch (err) {
    console.warn("[PR] resolveLinkForForm failed:", err.message);
    return interaction.reply({
      content: "❌ The Polymarket API took too long to answer. Please try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (form.error) {
    return interaction.reply({ content: `❌ ${form.error}`, flags: MessageFlags.Ephemeral });
  }

  // Immediate feedback for a direct market that is no longer requestable
  if (form.type === "market") {
    if (pm.isResolved(form.market) || form.market.closed) {
      return interaction.reply({
        content: `❌ **${form.market.question}** is already resolved/closed.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (pm.hasProposal(form.market)) {
      return interaction.reply({
        content: `❌ **${form.market.question}** already has an on-chain proposal (\`${form.market.umaResolutionStatus}\`).`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // Hide brackets that already have an active request (first come, first served)
  if (form.type === "event") {
    try {
      const active = await db.query(
        `SELECT condition_id FROM proposal_requests WHERE status IN ('pending','proposed')`,
      );
      const taken = new Set(active.rows.map((r) => r.condition_id));
      form.brackets = form.brackets.filter((b) => !b.conditionId || !taken.has(b.conditionId));
    } catch {
      /* non-fatal: createRequest dedupes anyway */
    }
    if (form.brackets.length === 0) {
      return interaction.reply({
        content: "❌ Every requestable market in that event already has an active request.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const remainingSlots = Math.max(1, maxActive - stats.active);
  const maxSelectable = Math.min(remainingSlots, 5);

  pruneForms();
  pendingForms.set(interaction.id, {
    type: form.type,
    marketSlug: form.type === "market" ? form.market.slug : null,
    createdAt: Date.now(),
  });

  return interaction.showModal(buildRequestModal(interaction.id, form, maxSelectable));
}

async function publishRequestCard(client, request, creditWindowHours) {
  try {
    const channel = await client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
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
}

async function handleRequestModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const formKey = interaction.customId.slice(REQUEST_MODAL_PREFIX.length);
  const form = pendingForms.get(formKey);
  pendingForms.delete(formKey);
  if (!form) {
    return interaction.editReply({
      content: "❌ This form expired (or the bot restarted). Please run `/request` again.",
    });
  }

  const outcomeInput = interaction.fields.getStringSelectValues("outcome")[0];
  const evidence = interaction.fields.getTextInputValue("evidence");
  const wallet = interaction.fields.getTextInputValue("wallet") || null;
  const slugs =
    form.type === "event"
      ? interaction.fields.getStringSelectValues("market")
      : [form.marketSlug];

  const settings = await db.getSettings();
  const creditWindowHours = parseInt(settings.credit_window_hours, 10);

  const created = [];
  const failed = [];
  for (const slug of slugs) {
    const result = await pr.createRequest({
      user: interaction.user,
      displayName: interaction.member?.displayName,
      marketSlug: slug,
      outcomeInput,
      evidence,
      wallet,
    });
    if (result.ok) {
      created.push(result.request);
      await publishRequestCard(interaction.client, result.request, creditWindowHours);
    } else {
      failed.push({ slug, error: result.error });
    }
  }

  if (created.length > 0) {
    refreshDashboard(interaction.client).catch(() => {});
  }

  const lines = [];
  for (const request of created) {
    lines.push(
      `✅ **#${request.id}** ${truncate(request.market_question, 100)} → **${request.requested_outcome}**` +
        (request.early_claim ? " ⚠️ *(early claim)*" : ""),
    );
  }
  for (const f of failed) {
    lines.push(`❌ \`${truncate(f.slug, 60)}\`: ${f.error}`);
  }
  if (created.length > 0) {
    lines.push(
      `\nA whitelisted proposer must propose within **${creditWindowHours}h** and the market must settle as requested for it to count toward your record.`,
    );
  }

  return interaction.editReply({ content: truncate(lines.join("\n"), 2000) });
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
        return handleRequestCommand(interaction);
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

    if (interaction.isModalSubmit() && interaction.customId.startsWith(REQUEST_MODAL_PREFIX)) {
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
