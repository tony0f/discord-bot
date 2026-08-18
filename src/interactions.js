const {
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");
const db = require("./db");
const pm = require("./polymarket");
const pr = require("./proposalRequests");
const erSearch = require("./erSearch");
const { buildRequestEmbed, buildDashboardEmbed } = require("./embeds");
const { refreshDashboard } = require("./watcher");
const {
  PROPOSAL_REQUESTS_CHANNEL_ID,
  PROPOSAL_BOT_CHANNEL_ID,
  RISK_LABS_ROLE_ID,
  ADMIN_USER_IDS,
  QUALIFY_MIN_SETTLED,
  QUALIFY_MIN_ACCURACY,
} = require("./config");

const WELCOME_NEW_ID = "prw:new";        // welcome button: start a request
const WELCOME_LIST_ID = "prw:list";      // welcome button: active requests board
const WELCOME_REPORT_ID = "prw:report";  // welcome button: add a community warning
const WELCOME_STATS_ID = "prw:stats";    // welcome button: my stats
const WELCOME_LB_ID = "prw:lb";          // welcome button: leaderboard
const WELCOME_LINK_MODAL_PREFIX = "prwl:"; // welcome flow: paste-the-link modal
const WELCOME_REPORT_MODAL_PREFIX = "prwr:"; // welcome flow: report modal

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

// Single-market flow: one modal with the market's real outcomes + evidence.
function buildSingleMarketModal(interactionId, market) {
  const outcomeOptions = [...(market.outcomes || ["Yes", "No"]), pm.TIE_OUTCOME];
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
    );
}

// Event flow, step 2: evidence modal shown after lines were selected.
function buildEvidenceModal(sessionId, lineCount) {
  return new ModalBuilder()
    .setCustomId(`${COMBO_MODAL_PREFIX}${sessionId}`)
    .setTitle(`Request ${lineCount} line(s)`)
    .addLabelComponents(evidenceLabel());
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

// ---------------------------------------------------------------------------
// Welcome message for the read-only bot channel: explainer + start buttons,
// always kept as the channel's last message.
// ---------------------------------------------------------------------------
let lastWelcomeId = null;
let repostingWelcome = false;

function buildWelcomePayload() {
  const embed = new EmbedBuilder()
    .setTitle("📋 Proposal Requests — start here")
    .setColor(0x3b82f6)
    .setDescription(
      [
        "Request that a **whitelisted proposer** proposes a Polymarket or Predict.fun market, and build your own accuracy record with every request that settles the way you called it.",
        "",
        "**How it works**",
        "1. Press **🚀 New request** and paste the market or event link.",
        "2. Pick the line(s) you want proposed — each with its own outcome.",
        "3. Add evidence (optional, but links and details help) and submit.",
        "",
        `Your request card appears in <#${PROPOSAL_REQUESTS_CHANNEL_ID}> for proposers and discussion. A proposal must land within the credit window and the market must **settle exactly as you requested** to count toward your record.`,
        "",
        "**Rules to know**",
        "• One request per market — first come, first served.",
        "• Don't request too early (P4): if the event hasn't resolved yet, wait. Premature requests can be denied credit after review.",
        "• See something off? Flag it with **🚩 Report** below (you'll need the request # from its card).",
      ].join("\n"),
    )
    .setFooter({ text: "Interactions here are private (only you see them) — the channel stays clean." });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(WELCOME_NEW_ID).setLabel("New request").setEmoji("🚀").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(WELCOME_LIST_ID).setLabel("Active requests").setEmoji("📋").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(WELCOME_REPORT_ID).setLabel("Report").setEmoji("🚩").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(WELCOME_STATS_ID).setLabel("My stats").setEmoji("📊").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(WELCOME_LB_ID).setLabel("Leaderboard").setEmoji("🏆").setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [buttons] };
}

async function ensureWelcomeMessage(client) {
  if (!db.isEnabled()) return;
  try {
    const channel = await client.channels.fetch(PROPOSAL_BOT_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    const settings = await db.getSettings();
    const existingId = settings.bot_channel_welcome_id;
    if (existingId) {
      const existing = await channel.messages.fetch(existingId).catch(() => null);
      if (existing) {
        lastWelcomeId = existing.id;
        // Refresh content in place so copy changes deploy without reposting
        await existing.edit(buildWelcomePayload()).catch(() => {});
        return;
      }
    }
    const sent = await channel.send(buildWelcomePayload());
    lastWelcomeId = sent.id;
    await db.setSetting("bot_channel_welcome_id", sent.id);
    console.log("[PR] Welcome message posted in the bot channel.");
  } catch (err) {
    console.warn("[PR] Could not ensure welcome message:", err.message);
  }
}

// If anything else lands in the bot channel, repost the welcome so the start
// button is always the channel's last message.
async function keepWelcomeLast(client, message) {
  if (message.channelId !== PROPOSAL_BOT_CHANNEL_ID) return;
  if (message.id === lastWelcomeId) return;
  if (repostingWelcome || !db.isEnabled()) return;
  repostingWelcome = true;
  try {
    const channel = message.channel;
    if (lastWelcomeId) {
      await channel.messages.delete(lastWelcomeId).catch(() => {});
    }
    const sent = await channel.send(buildWelcomePayload());
    lastWelcomeId = sent.id;
    await db.setSetting("bot_channel_welcome_id", sent.id);
  } catch (err) {
    console.warn("[PR] Could not repost welcome message:", err.message);
  } finally {
    repostingWelcome = false;
  }
}

// Active/daily caps shared by every entry point. Returns an error string or null.
async function checkUserGates(userId) {
  const settings = await db.getSettings();
  const stats = await pr.getUserStats(userId);
  const maxActive = parseInt(settings.max_active_per_user, 10);
  if (stats.active >= maxActive) {
    return `❌ You already have **${stats.active} active requests** (max ${maxActive}). Wait until some are proposed or expire.`;
  }
  const dailyLimit = parseInt(settings.daily_request_limit, 10);
  if (stats.last24h >= dailyLimit) {
    return `❌ You reached the limit of **${dailyLimit} requests per 24h**. Try again later.`;
  }
  return null;
}

function buildWelcomeLinkModal(interactionId) {
  return new ModalBuilder()
    .setCustomId(`${WELCOME_LINK_MODAL_PREFIX}${interactionId}`)
    .setTitle("New proposal request")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Market or event link")
        .setDescription("From polymarket.com or predict.fun")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("link")
            .setPlaceholder("https://polymarket.com/event/…")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(400)
            .setRequired(true),
        ),
    );
}

function buildWelcomeReportModal(interactionId) {
  return new ModalBuilder()
    .setCustomId(`${WELCOME_REPORT_MODAL_PREFIX}${interactionId}`)
    .setTitle("Report a request")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Request number")
        .setDescription("The # shown on the request card (e.g. 50)")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("request_id")
            .setPlaceholder("50")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(10)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel("Why this request should not be trusted")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("reason")
            .setPlaceholder("Too early (P4), wrong outcome, fake evidence…")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(500)
            .setRequired(true),
        ),
    );
}

async function handleWelcomeReportSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rawId = interaction.fields.getTextInputValue("request_id").replace(/[#\s]/g, "");
  const id = parseInt(rawId, 10);
  if (Number.isNaN(id) || id <= 0) {
    return interaction.editReply({
      content: `❌ \`${rawId}\` is not a valid request number. Find the # in the card footer in <#${PROPOSAL_REQUESTS_CHANNEL_ID}>.`,
    });
  }
  const reason = interaction.fields.getTextInputValue("reason");
  return executeReport(interaction, id, reason);
}

// Welcome-button flow: the link arrives via modal, so the response is already
// past showModal territory — every shape (event or single market) continues
// in the ephemeral picker.
async function handleWelcomeLinkSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const link = interaction.fields.getTextInputValue("link");
  const gateError = await checkUserGates(interaction.user.id);
  if (gateError) return interaction.editReply({ content: gateError });

  let form;
  try {
    form = await pm.resolveLinkForForm(link);
  } catch (err) {
    console.warn("[PR] resolveLinkForForm failed:", err.message);
    return interaction.editReply({
      content: "❌ The market API took too long to answer. Please try again.",
    });
  }
  if (form.error) return interaction.editReply({ content: `❌ ${form.error}` });

  if (form.type === "market") {
    form = {
      type: "event",
      eventTitle: form.market.title,
      brackets: [form.market],
      expandable: false,
    };
  }
  return respondWithPicker(interaction, form, link);
}

async function handleRequestCommand(interaction) {
  // Everything here must finish within Discord's 3s window (showModal cannot
  // be deferred), so the Gamma lookup runs with a hard timeout.
  const link = interaction.options.getString("link");

  const gateError = await checkUserGates(interaction.user.id);
  if (gateError) {
    return interaction.reply({ content: gateError, flags: MessageFlags.Ephemeral });
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
  // resolveLinkForForm only returns requestable markets, so no extra gates.
  if (form.type === "market") {
    pruneForms();
    pendingForms.set(interaction.id, {
      kind: "market",
      marketSlug: form.market.slug,
      sourceUrl: link,
      createdAt: Date.now(),
    });
    return interaction.showModal(buildSingleMarketModal(interaction.id, form.market));
  }

  // --- Event flow: line×outcome pickers. Brackets come fresh from the 3PO
  // search; enrich Polymarket ones with real outcome names via Gamma. ---
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return respondWithPicker(interaction, form, link);
}

// Ephemeral line×outcome picker for an already-deferred interaction. Used by
// the /request event flow and by the welcome-button flow (where chaining a
// second modal is impossible, so even single markets go through the picker).
async function respondWithPicker(interaction, form, link) {
  let requestable = form.brackets;

  // Sports pages aggregate sibling events (-more-markets, -total-corners...)
  // — discover them and merge every requestable line
  if (form.expandable) {
    try {
      requestable = await pm.expandEventBrackets(form);
    } catch (err) {
      console.warn("[PR] Sibling expansion failed:", err.message);
    }
  }

  // Hide markets that already have an active request (first come, first served)
  try {
    const active = await db.query(
      `SELECT condition_id FROM proposal_requests WHERE status IN ('pending','proposed')`,
    );
    const taken = new Set(active.rows.map((r) => r.condition_id));
    requestable = requestable.filter((b) => !taken.has(b.conditionId));
  } catch {
    /* non-fatal: createRequest dedupes anyway */
  }

  if (requestable.length === 0) {
    return interaction.editReply({
      content:
        "❌ Every market in that event is already proposed, settled, or has an active request — nothing left to request.",
    });
  }

  // Outcome names: bulk Gamma lookup for Polymarket brackets (team names,
  // Over/Under, bracket short titles); Predict.fun markets are binary.
  const gammaBySlug = new Map();
  const pmSlugs = requestable.filter((b) => b.creationSource === "polymarket").map((b) => b.slug);
  if (pmSlugs.length > 0) {
    try {
      for (const g of await pm.fetchMarketsBySlugs(pmSlugs)) gammaBySlug.set(g.slug, g);
    } catch (err) {
      console.warn("[PR] Gamma bulk outcome lookup failed:", err.message);
    }
  }

  const combos = [];
  for (const bracket of requestable) {
    const gamma = gammaBySlug.get(bracket.slug);
    const gammaOutcomes = gamma ? pm.getOutcomes(gamma) : [];
    const outcomes = gammaOutcomes.length > 0 ? gammaOutcomes : ["Yes", "No"];
    const market = { slug: bracket.slug, question: bracket.title };
    const title = gamma?.groupItemTitle || bracket.title;
    // The outcome must never be hidden — it is what tells options apart.
    // Discord's client visually clips labels around ~40 chars, so long
    // titles would swallow a trailing outcome: lead with the outcome then.
    const buildLabel = (outcome) => {
      if (title.length > 38) {
        return truncate(`${outcome} — ${title}`, 100);
      }
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
    sourceUrl: link,
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
        const evidenceIds = [];
        for (let i = 0; i < chunks.length; i++) {
          const payload = { content: chunks[i] };
          if (i === 0) {
            payload.reply = { messageReference: message.id, failIfNotExists: false };
            payload.allowedMentions = { parse: [] };
          }
          const sent = await channel.send(payload);
          evidenceIds.push(sent.id);
        }
        if (evidenceIds.length > 0) {
          await pr.updateRequestStatus(request.id, {
            evidence_message_ids: JSON.stringify(evidenceIds),
          });
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
async function processRequests(interaction, items, evidence, sourceUrl) {
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
      fallbackUrl: sourceUrl,
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

  const content = await processRequests(
    interaction,
    [{ slug: form.marketSlug, outcome }],
    evidence,
    form.sourceUrl,
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

  // One outcome per market: block Continue until the selection is coherent
  const combos = selected.map((v) => session.combos[v]).filter(Boolean);
  const seenBySlug = new Map();
  const conflicts = [];
  for (const combo of combos) {
    if (seenBySlug.has(combo.slug)) {
      const first = seenBySlug.get(combo.slug);
      conflicts.push(`• **${first.label}** ⇄ **${combo.label}**`);
    } else {
      seenBySlug.set(combo.slug, combo);
    }
  }
  if (conflicts.length > 0) {
    return interaction.reply({
      content: truncate(
        `⚠️ You picked **more than one outcome for the same market** — a request needs exactly one:\n${conflicts.join("\n")}\n\nDeselect the extras and press **Continue** again.`,
        2000,
      ),
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

  let content = await processRequests(interaction, items, evidence, session.sourceUrl);
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
    .setColor(0x3498db)
    .addFields(
      { name: "Active (pending/proposed)", value: `${stats.active}`, inline: true },
      { name: "Settled correct (6m)", value: `${stats.correct6m}`, inline: true },
      { name: "Settled incorrect (6m)", value: `${stats.incorrect6m}`, inline: true },
      { name: "Accuracy (6m)", value: accuracyText, inline: true },
      { name: "Expired (no proposal)", value: `${stats.expired}`, inline: true },
      { name: "Total requests", value: `${stats.total}`, inline: true },
    );
  return interaction.editReply({ embeds: [embed] });
}

async function handleLeaderboard(interaction, ephemeral = false) {
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
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
    .setTimestamp(new Date());
  return interaction.editReply({ embeds: [embed] });
}

async function handleRequestsList(interaction, ephemeral = false) {
  // public by default: proposers browse this together
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  const settings = await db.getSettings();
  const requests = await pr.listActiveRequests();
  const reportsMap = await pr.getReportsMap(requests.map((r) => r.id));
  const accuracyMap = await pr.getAccuracyMap([...new Set(requests.map((r) => r.discord_user_id))]);
  const embed = buildDashboardEmbed(requests, {
    creditWindowHours: parseInt(settings.credit_window_hours, 10),
    reportsMap,
    accuracyMap,
  });
  return interaction.editReply({ embeds: [embed] });
}

async function handleReport(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.options.getInteger("id");
  const reason = interaction.options.getString("reason");
  return executeReport(interaction, id, reason);
}

// Shared by /report and the welcome-channel Report button (already deferred)
async function executeReport(interaction, id, reason) {
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

async function handleErSearch(interaction) {
  if (!hasAccess(interaction.member)) {
    return interaction.reply({
      content: "⛔ This command requires Administrator permissions or the Risk Labs role.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const query = interaction.options.getString("query");
  const fromMs = erSearch.parseDay(interaction.options.getString("from"));
  const toInput = interaction.options.getString("to");
  const toMs = toInput
    ? erSearch.parseDay(toInput, true)
    : Date.now();

  if (fromMs === null || toMs === null) {
    return interaction.reply({
      content: "❌ Invalid date format. Use `YYYY-MM-DD` (e.g. `2026-08-01`).",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (fromMs > toMs) {
    return interaction.reply({
      content: "❌ `from` must be before `to`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const { markdown, threadCount, commentCount, truncated } = await erSearch.searchToMarkdown(
      interaction.client,
      { query, fromMs, toMs },
    );

    const safeQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "search";
    const file = new AttachmentBuilder(Buffer.from(markdown, "utf8"), {
      name: `er-threads-${safeQuery}-${new Date(fromMs).toISOString().slice(0, 10)}.md`,
    });

    return interaction.editReply({
      content:
        `🔎 Found **${threadCount} thread(s)** with **${commentCount} user comment(s)** matching \`${query}\`.` +
        (truncated ? "\n⚠️ Result was capped — narrow the date range for full coverage." : ""),
      files: [file],
    });
  } catch (err) {
    console.error("[ER Search] Failed:", err);
    return interaction.editReply({
      content: `❌ Search failed: ${err.message}`,
    });
  }
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
    const deleteMessages = interaction.options.getBoolean("delete_messages") || false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const request = await pr.getRequestById(id);
    if (!request) {
      return interaction.editReply({ content: `❌ Request #${id} not found.` });
    }
    if (["settled_correct", "settled_incorrect", "credit_denied"].includes(request.status)) {
      return interaction.editReply({
        content: `⚠️ Request #${id} is already settled (\`${request.status}\`). Invalidating it anyway would rewrite history — not allowed.`,
      });
    }

    // Denying an under-review credit counts as a loss, not a neutral removal
    const denied = request.status === "under_review";
    const updated = denied
      ? await pr.denyCredit(id, reason)
      : await pr.invalidateRequest(id, reason);
    const { editRequestMessage, purgeRequestMessages } = require("./watcher");
    if (deleteMessages) {
      await purgeRequestMessages(interaction.client, updated).catch(() => {});
    } else {
      await editRequestMessage(interaction.client, updated).catch(() => {});
    }
    refreshDashboard(interaction.client).catch(() => {});
    return interaction.editReply({
      content: denied
        ? `✅ Credit denied for request #${id} — counted as **incorrect**${deleteMessages ? ", Discord messages deleted" : ""}. Reason: ${reason}`
        : `✅ Request #${id} invalidated${deleteMessages ? " and its Discord messages were deleted" : ""}. Reason: ${reason}`,
    });
  }

  if (sub === "approve_credit") {
    const id = interaction.options.getInteger("id");
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const request = await pr.getRequestById(id);
    if (!request) {
      return interaction.editReply({ content: `❌ Request #${id} not found.` });
    }
    if (request.status !== "under_review") {
      return interaction.editReply({
        content: `⚠️ Request #${id} is not under review (status: \`${request.status}\`).`,
      });
    }

    const updated = await pr.updateRequestStatus(id, {
      status: "settled_correct",
      invalidated_reason: null,
    });
    const { editRequestMessage, notifyResult } = require("./watcher");
    await editRequestMessage(interaction.client, updated).catch(() => {});
    await notifyResult(interaction.client, updated).catch(() => {});
    refreshDashboard(interaction.client).catch(() => {});
    return interaction.editReply({
      content: `✅ Credit approved for request #${id} — now counted as correct.`,
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
        `- Record complete (${QUALIFY_MIN_SETTLED}+ settled, ≥${QUALIFY_MIN_ACCURACY * 100}%): **${stats.qualified ? "YES 🎓" : "no"}**`,
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
      if (commandName === "er-search") {
        return handleErSearch(interaction);
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
      if (interaction.customId === WELCOME_NEW_ID) {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return interaction.showModal(buildWelcomeLinkModal(interaction.id));
      }
      if (interaction.customId === WELCOME_LIST_ID) {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleRequestsList(interaction, true);
      }
      if (interaction.customId === WELCOME_REPORT_ID) {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return interaction.showModal(buildWelcomeReportModal(interaction.id));
      }
      if (interaction.customId === WELCOME_STATS_ID) {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleMyStats(interaction);
      }
      if (interaction.customId === WELCOME_LB_ID) {
        if (!db.isEnabled()) return dbDisabledReply(interaction);
        return handleLeaderboard(interaction, true);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      if (!db.isEnabled()) return dbDisabledReply(interaction);
      if (interaction.customId.startsWith(WELCOME_LINK_MODAL_PREFIX)) {
        return handleWelcomeLinkSubmit(interaction);
      }
      if (interaction.customId.startsWith(WELCOME_REPORT_MODAL_PREFIX)) {
        return handleWelcomeReportSubmit(interaction);
      }
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

module.exports = { handleInteraction, ensureWelcomeMessage, keepWelcomeLast };
