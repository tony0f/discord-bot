const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { DISCORD_TOKEN } = require("./src/config");
const db = require("./src/db");
const disputeMonitor = require("./src/disputeMonitor");
const watcher = require("./src/watcher");
const webServer = require("./src/webServer");
const { handleInteraction } = require("./src/interactions");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.ThreadMember],
});

client.on("messageCreate", (message) => {
  disputeMonitor.handleMessage(client, message).catch((err) => {
    console.error("[Dispute Monitor] Unhandled error:", err);
  });
});

client.on("interactionCreate", handleInteraction);

client.on("warn", console.warn);
client.on("error", console.error);

client.on("ready", () => {
  console.log(`${client.user.tag} has connected to Discord and is ready!`);

  disputeMonitor.runInitialDisputeScan(client);
  setInterval(() => disputeMonitor.cleanupDisputeCache(client), 12 * 60 * 60 * 1000);

  watcher.start(client);
  webServer.start(client);
});

async function initializeBot() {
  if (!DISCORD_TOKEN) {
    console.error("Critical env var DISCORD_TOKEN missing. Bot will not start.");
    return;
  }

  try {
    await db.init();
  } catch (err) {
    console.error("[DB] Initialization failed — proposal-requests features disabled:", err.message);
  }

  client.login(DISCORD_TOKEN).catch((err) => {
    console.error("Failed to log into Discord:", err);
    if (
      err.code === "TokenInvalid" ||
      (err.message && err.message.includes("Privileged Intents"))
    ) {
      console.error("CHECK TOKEN & INTENTS IN DISCORD DEV PORTAL.");
    }
  });
}

initializeBot();
