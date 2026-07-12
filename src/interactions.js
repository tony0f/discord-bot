const {
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");
const db = require("./db");
const pm = require("./polymarket");
const pr = require("./proposalRequests");
const { buildRequestEmbed, buildDashboardEmbed } = require("./embeds");
const { refreshDashboard } = require("./watcher");
const {
  PROPOSAL_REQUESTS_CHANNEL_ID,
  RISK_LABS_ROLE_ID,
  ADMIN_USER_IDS,
  QUALIFY_MIN_SETTLED,
  QUALIFY_MIN_ACCURACY,
} = require("./config");

const REQUEST_MODAL_PREFIX = "prq:";     // single-market flow: outcome+evidence modal
const COMBO_MODAL_PREFIX = "prq2:";      // event flow: evidence modal after line selection
const COMBO_SELECT_PREFIX = "prqsel:";   // event flow: line→outcome select menus
const COMBO_GO_PREFIX = "prqgo:";        // event flow: Continue button
const COMBO_CANCEL_PREFIX = "prqcancel:"; // event flow: Cancel button

// Context captured when /request is invoked, consumed by later interactions.
// Keyed by the command interaction id (embedded in component customIds).
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

function evidenceLabel() {
  return new LabelBuilder()
    .setLabel("Evidence (optional — links and details help)")
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId("evidence")
        .setPlaceholder("Sources proving the outcome, e.g. an X post, article, official page…")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(false),
    );
}

function walletLabel() {
  return new LabelBuilder()
    .setLabel("Your wallet address (optional)")
    .setTextInputComponent(
      new TextInputBuilder()
        .setCustomId("wallet")
        .setPlaceholder("0x… — needed later for whitelist inclusion")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(50)
        .setRequired(false),
    );
}

// Single-market flow: one modal with the market's real outcomes + evidence.
function buildSingleMarketModal(interactionId, market) {
  const outcomeOptions = [...pm.getOutcomes(market), pm.TIE_OUTCOME];
  return new ModalBuilder()
    .setCustomId(`${REQUEST_MODAL_PREFIX}${interactionId}`)
    .setTitle("Request a market proposal")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Proposed outcome")
        .setDescription(truncate(market.question, 100))
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
      evidenceLabel(),
      walletLabel(),
    );
}

// Event flow, step 2: evidence modal shown after lines were selected.
function buildEvidenceModal(sessionId, lineCount) {
  return new ModalBuilder()
    .setCustomId(`${COMBO_MODAL_PREFIX}${sessionId}`)
    .setTitle(`Request ${lineCount} line(s)`)
    .addLabelComponents(evidenceLabel(), walletLabel());
}

// Event flow, step 1: every requestable line×outcome pair as an option,
// spread over up to 4 multi-selects (25 options each), plus buttons.
const MAX_COMBO_SELECTS = 4;

function buildComboComponents(sessionId, combos) {
  const rows = [];
  for (let i = 0; i < combos.length && rows.length < MAX_COMBO_SELECTS; i += 25) {
    const chunk = combos.slice(i, i + 25);
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${COMBO_SELECT_PREFIX}${sessionId}:${rows.length}`)
          .setPlaceholder(
            combos.length > 25
              ? `Select line(s) — ${i + 1} to ${i + chunk.length}`
              : "Select the line(s) you want proposed",
          )
          .setMinValues(0)
          .setMaxValues(chunk.length)
          .addOptions(
            chunk.map((c) => ({
              label: truncate(c.label, 100),
              value: c.value,
              description: truncate(c.question, 100),
            })),
          ),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${COMBO_GO_PREFIX}${sessionId}`)
        .setLabel("Continue →")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${COMBO_CANCEL_PREFIX}${sessionId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return rows;
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

  // --- Single-market flow: straight to the modal (cannot defer showModal) ---
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

    pruneForms();
    pendingForms.set(interaction.id, {
      kind: "market",
      marketSlug: form.market.slug,
      createdAt: Date.now(),
    });
    return interaction.showModal(buildSingleMarketModal(interaction.id, form.market));
  }

  // --- Event flow: line×outcome pickers. A normal reply CAN be deferred, so
  // there is time to re-verify every bracket with fresh full-market data
  // (the event endpoint's nested statuses can be stale). ---
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let freshMarkets;
  try {
    freshMarkets = await pm.fetchMarketsBySlugs(form.brackets.map((b) => b.slug));
  } catch (err) {
    console.warn("[PR] Bulk market fetch failed:", err.message);
    return interaction.editReply({
      content: "❌ The Polymarket API failed while loading the event's markets. Please try again.",
    });
  }

  let requestable = freshMarkets.filter(
    (m) => !m.closed && !pm.isResolved(m) && !pm.hasProposal(m),
  );

  // Hide markets that already have an active request (first come, first served)
  try {
    const active = await db.query(
      `SELECT condition_id FROM proposal_requests WHERE status IN ('pending','proposed')`,
    );
    const taken = new Set(active.rows.map((r) => r.condition_id));
    requestable = requestable.filter((m) => !taken.has(m.conditionId));
  } catch {
    /* non-fatal: createRequest dedupes anyway */
  }

  if (requestable.length === 0) {
    return interaction.editReply({
      content:
        "❌ Every market in that event is already proposed, resolved, or has an active request — nothing left to request.",
    });
  }

  const combos = [];
  for (const market of requestable) {
    const outcomes = pm.getOutcomes(market);
    const title = market.groupItemTitle || market.question;
    // The outcome must never be truncated away — it is what tells options apart
    const buildLabel = (outcome) => {
      const room = Math.max(20, 100 - (outcome.length + 3));
      return truncate(`${truncate(title, room)} → ${outcome}`, 100);
    };
    for (let i = 0; i < outcomes.length; i++) {
      combos.push({
        value: `${market.slug}|${i}`,
        slug: market.slug,
        outcome: outcomes[i],
        label: buildLabel(outcomes[i]),
        question: market.question,
      });
    }
    combos.push({
      value: `${market.slug}|tie`,
      slug: market.slug,
      outcome: pm.TIE_OUTCOME,
      label: buildLabel(`${pm.TIE_OUTCOME} (P3)`),
      question: market.question,
    });
  }
  const shown = combos.slice(0, MAX_COMBO_SELECTS * 25);

  pruneForms();
  pendingForms.set(interaction.id, {
    kind: "combo",
    combos: Object.fromEntries(shown.map((c) => [c.value, c])),
    selections: {},
    createdAt: Date.now(),
  });

  let content =
    `**${form.eventTitle}**\n` +
    `Found **${requestable.length} requestable market(s)** (${shown.length} line options). ` +
    `Pick every line you want proposed — each with its own outcome — then press **Continue**.`;
  if (combos.length > shown.length) {
    content += `\n⚠️ ${combos.length - shown.length} option(s) could not be shown (Discord limit). Use a direct market link for those.`;
  }

  return interaction.editReply({
    content,
    components: buildComboComponents(interaction.id, shown),
  });
}

async function publishRequestCard(client, request, creditWindowHours) {
  try {
    const channel = await client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
    const message = await channel.send({
      embeds: [buildRequestEmbed(request, { creditWindowHours })],
    });
    await pr.setRequestMessage(request.id, channel.id, message.id);

    // Full evidence goes below the card as a plain message: full width,
    // clickable links with previews, and no embed length limits.
    if (request.evidence && request.evidence.length > 250) {
      try {
        const header = `📎 **Evidence — request #${request.id}** (from <@${request.discord_user_id}>):\n`;
        const chunks =
          (header + request.evidence).match(/[\s\S]{1,1900}/g) || [];
        for (let i = 0; i < chunks.length; i++) {
          const payload = { content: chunks[i] };
          if (i === 0) {
            payload.reply = { messageReference: message.id, failIfNotExists: false };
            payload.allowedMentions = { parse: [] };
          }
          await channel.send(payload);
        }
      } catch (evidenceErr) {
        console.warn(`[PR] Could not post full evidence for request #${request.id}:`, evidenceErr.message);
      }
    }

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

// Shared tail of both flows: create each request, publish cards, summarize.
async function processRequests(interaction, items, evidence, wallet) {
  const settings = await db.getSettings();
  const creditWindowHours = parseInt(settings.credit_window_hours, 10);

  const created = [];
  const failed = [];
  for (const item of items) {
    const result = await pr.createRequest({
      user: interaction.user,
      displayName: interaction.member?.displayName,
      marketSlug: item.slug,
      outcomeInput: item.outcome,
      evidence,
      wallet,
    });
    if (result.ok) {
      created.push(result.request);
      await publishRequestCard(interaction.client, result.request, creditWindowHours);
    } else {
      failed.push({ label: item.label || item.slug, error: result.error });
    }
  }

  if (created.length > 0) {
    refreshDashboard(interaction.client).catch(() => {});
  }

  const lines = [];
  for (const request of created) {
    lines.push(
      `✅ **#${request.id}** ${truncate(request.market_question, 80)} → **${request.requested_outcome}**`,
    );
  }
  for (const f of failed) {
    lines.push(`❌ **${truncate(f.label, 60)}**: ${f.error}`);
  }
  if (created.length > 0) {
    lines.push(
      `\nA whitelisted proposer must propose within **${creditWindowHours}h** and the market must settle as requested for it to count toward your record.`,
    );
  }
  return truncate(lines.join("\n"), 2000);
}

async function handleRequestModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const formKey = interaction.customId.slice(REQUEST_MODAL_PREFIX.length);
  const form = pendingForms.get(formKey);
  pendingForms.delete(formKey);
  if (!form || form.kind !== "market") {
    return interaction.editReply({
      content: "❌ This form expired (or the bot restarted). Please run `/request` again.",
    });
  }

  const outcome = interaction.fields.getStringSelectValues("outcome")[0];
  const evidence = interaction.fields.getTextInputValue("evidence") || "";
  const wallet = interaction.fields.getTextInputValue("wallet") || null;

  const content = await processRequests(
    interaction,
    [{ slug: form.marketSlug, outcome }],
    evidence,
    wallet,
  );
  return interaction.editReply({ content });
}

async function handleComboSelect(interaction) {
  const [sessionId, idx] = interaction.customId
    .slice(COMBO_SELECT_PREFIX.length)
    .split(":");
  const session = pendingForms.get(sessionId);
  if (!session || session.kind !== "combo") {
    return interaction.update({
      content: "❌ This picker expired. Please run `/request` again.",
      components: [],
    });
  }
  session.selections[idx] = interaction.values;
  return interaction.deferUpdate();
}

async function handleComboContinue(interaction) {
  const sessionId = interaction.customId.slice(COMBO_GO_PREFIX.length);
  const session = pendingForms.get(sessionId);
  if (!session || session.kind !== "combo") {
    return interaction.update({
      content: "❌ This picker expired. Please run `/request` again.",
      components: [],
    });
  }
  const selected = Object.values(session.selections).flat();
  if (selected.length === 0) {
    return interaction.reply({
      content: "Select at least one line first.",
      flags: MessageFlags.Ephemeral,
    });
  }
  return interaction.showModal(buildEvidenceModal(sessionId, selected.length));
}

async function handleComboCancel(interaction) {
  const sessionId = interaction.customId.slice(COMBO_CANCEL_PREFIX.length);
  pendingForms.delete(sessionId);
  return interaction.update({ content: "Request cancelled.", components: [] });
}

async function handleComboModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sessionId = interaction.customId.slice(COMBO_MODAL_PREFIX.length);
  const session = pendingForms.get(sessionId);
  pendingForms.delete(sessionId);
  if (!session || session.kind !== "combo") {
    return interaction.editReply({
      content: "❌ This form expired (or the bot restarted). Please run `/request` again.",
    });
  }

  const evidence = interaction.fields.getTextInputValue("evidence") || "";
  const wallet = interaction.fields.getTextInputValue("wallet") || null;

  const raw = Object.values(session.selections)
    .flat()
    .map((v) => session.combos[v])
    .filter(Boolean);

  // Both outcomes of the same market can't be requested together
  const seenSlugs = new Set();
  const items = [];
  let conflicts = 0;
  for (const combo of raw) {
    if (seenSlugs.has(combo.slug)) {
      conflicts++;
      continue;
    }
    seenSlugs.add(combo.slug);
    items.push(combo);
  }

  let content = await processRequests(interaction, items, evidence, wallet);
  if (conflicts > 0) {
    content = truncate(
      `⚠️ Skipped ${conflicts} selection(s) that conflicted with another outcome for the same market.\n${content}`,
      2000,
    );
  }
  return interaction.editReply({ content });
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

async function handleRequestsList(interaction) {
  await interaction.deferReply(); // public: proposers browse this together
  const settings = await db.getSettings();
  const requests = await pr.listActiveRequests();
  const reportsMap = await pr.getReportsMap(requests.map((r) => r.id));
  const embed = buildDashboardEmbed(requests, {
    creditWindowHours: parseInt(settings.credit_window_hours, 10),
    reportsMap,
  });
  return interaction.editReply({ embeds: [embed] });
}

async function handleReport(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.options.getInteger("id");
  const reason = interaction.options.getString("reason");

  const result = await pr.reportRequest(id, interaction.user, reason);
  if (!result.ok) {
    return interaction.editReply({ content: `❌ ${result.error}` });
  }
  const request = result.request;

  const { editRequestMessage } = require("./watcher");
  await editRequestMessage(interaction.client, request).catch(() => {});
  refreshDashboard(interaction.client).catch(() => {});

  const warningCount = result.reports.length;

  // Public accountability: announce the warning under the request card
  try {
    const channel = await interaction.client.channels.fetch(PROPOSAL_REQUESTS_CHANNEL_ID);
    const payload = {
      content:
        `🚨 <@${interaction.user.id}> added a **community warning** to request **#${request.id}** (by <@${request.discord_user_id}>)` +
        `${warningCount > 1 ? ` — now **${warningCount} warnings**` : ""}:\n> ${reason}\nAdmins will review it.`,
    };
    if (request.message_id) {
      payload.reply = { messageReference: request.message_id, failIfNotExists: false };
    }
    await channel.send(payload);
  } catch (err) {
    console.warn(`[PR] Could not announce report for #${request.id}:`, err.message);
  }

  return interaction.editReply({
    content: `✅ Community warning added to request **#${request.id}** (${warningCount} total). Admins will review it — thank you for keeping the system honest.`,
  });
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

  if (sub === "clear_flag") {
    const id = interaction.options.getInteger("id");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const request = await pr.getRequestById(id);
    if (!request) {
      return interaction.editReply({ content: `❌ Request #${id} not found.` });
    }
    const reports = await pr.getReports(id);
    if (reports.length === 0) {
      return interaction.editReply({ content: `Request #${id} has no community warnings to clear.` });
    }

    const updated = await pr.clearReports(id);
    const { editRequestMessage } = require("./watcher");
    await editRequestMessage(interaction.client, updated).catch(() => {});
    refreshDashboard(interaction.client).catch(() => {});
    return interaction.editReply({
      content: `✅ Cleared **${reports.length}** community warning(s) from request #${id}.`,
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
      if (commandName === "requests") {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleRequestsList(interaction);
      }
      if (commandName === "report") {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleReport(interaction);
      }
      if (commandName === "pr-admin") {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleAdmin(interaction);
      }
      return;
    }

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith(COMBO_SELECT_PREFIX)
    ) {
      return handleComboSelect(interaction);
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith(COMBO_GO_PREFIX)) {
        return handleComboContinue(interaction);
      }
      if (interaction.customId.startsWith(COMBO_CANCEL_PREFIX)) {
        return handleComboCancel(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (!db.isEnabled()) return dbDisabledReply(interaction);
      if (interaction.customId.startsWith(COMBO_MODAL_PREFIX)) {
        return handleComboModalSubmit(interaction);
      }
      if (interaction.customId.startsWith(REQUEST_MODAL_PREFIX)) {
        return handleRequestModalSubmit(interaction);
      }
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
