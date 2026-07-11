// deploy-commands.js
// Registers the bot's slash commands. Run once after any command change:
//   node deploy_commands.js
require("dotenv").config();
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require("discord.js");
const { REST } = require("@discordjs/rest");
const { Routes } = require("discord-api-types/v9");

const BOT_ID = process.env.BOT_ID; // Client ID
const GUILD_ID = process.env.GUILD_ID; // Optional: guild used for testing
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!BOT_ID || !DISCORD_TOKEN) {
  console.error(
    "Error: BOT_ID or DISCORD_TOKEN is missing in .env for deploy-commands.js.",
  );
  process.exit(1);
}

const requestCommand = new SlashCommandBuilder()
  .setName("request")
  .setDescription(
    "Request a whitelisted proposer to propose a Polymarket market (counts toward your record).",
  )
  .addStringOption((opt) =>
    opt
      .setName("link")
      .setDescription("Polymarket link (event or specific market).")
      .setMaxLength(400)
      .setRequired(true),
  );

const myStatsCommand = new SlashCommandBuilder()
  .setName("mystats")
  .setDescription("View your proposal-request stats and whitelist progress.");

const leaderboardCommand = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("Proposal-requests leaderboard (last 6 months).");

const requestsListCommand = new SlashCommandBuilder()
  .setName("requests")
  .setDescription("List all active proposal requests (pending and proposed).");

const reportCommand = new SlashCommandBuilder()
  .setName("report")
  .setDescription("Flag a proposal request you believe is bad-faith or incorrect.")
  .addIntegerOption((opt) =>
    opt
      .setName("id")
      .setDescription("Request ID (shown in the card footer).")
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("reason")
      .setDescription("Why this request should not be trusted.")
      .setMaxLength(500)
      .setRequired(true),
  );

const adminCommand = new SlashCommandBuilder()
  .setName("pr-admin")
  .setDescription("Admin settings for the proposal-requests system.")
  // Hidden from members without Administrator. Server admins can grant it to
  // specific roles/users via Server Settings → Integrations → command permissions.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("view_settings")
      .setDescription("View the current proposal-requests settings."),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set_credit_window")
      .setDescription("Hours a request has to be proposed before it expires.")
      .addIntegerOption((opt) =>
        opt
          .setName("hours")
          .setDescription("Credit window in hours (e.g. 24).")
          .setMinValue(1)
          .setMaxValue(720)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set_max_active")
      .setDescription("Max simultaneous active requests per user.")
      .addIntegerOption((opt) =>
        opt
          .setName("value")
          .setDescription("Maximum active requests (e.g. 5).")
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set_daily_limit")
      .setDescription("Max requests per user per 24 hours.")
      .addIntegerOption((opt) =>
        opt
          .setName("value")
          .setDescription("Daily limit (e.g. 10).")
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set_poll_interval")
      .setDescription("Minutes between market-state checks.")
      .addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("Poll interval in minutes (e.g. 5).")
          .setMinValue(1)
          .setMaxValue(120)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set_dashboard_channel")
      .setDescription("Channel where the live request board is posted.")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Text channel for the live board.")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("invalidate")
      .setDescription("Invalidate a request (spam, bad faith, etc.).")
      .addIntegerOption((opt) =>
        opt
          .setName("id")
          .setDescription("Request ID (shown in the embed footer).")
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("reason")
          .setDescription("Reason for invalidation.")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear_flag")
      .setDescription("Remove a community warning from a request.")
      .addIntegerOption((opt) =>
        opt
          .setName("id")
          .setDescription("Request ID.")
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("user_stats")
      .setDescription("View another user's proposal-request stats.")
      .addUserOption((opt) =>
        opt
          .setName("user")
          .setDescription("The user to inspect.")
          .setRequired(true),
      ),
  );

const commands = [
  requestCommand.toJSON(),
  myStatsCommand.toJSON(),
  leaderboardCommand.toJSON(),
  requestsListCommand.toJSON(),
  reportCommand.toJSON(),
  adminCommand.toJSON(),
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    if (GUILD_ID) {
      // For testing: propagates instantly
      await rest.put(Routes.applicationGuildCommands(BOT_ID, GUILD_ID), {
        body: commands,
      });
      console.log(`Successfully registered commands for guild ${GUILD_ID}.`);
    } else {
      // For production: may take up to 1 hour to propagate
      await rest.put(Routes.applicationCommands(BOT_ID), { body: commands });
      console.log("Successfully registered commands globally.");
    }
  } catch (error) {
    console.error("Error reloading application (/) commands:", error);
  }
})();
