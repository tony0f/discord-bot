require("dotenv").config();

module.exports = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DATABASE_URL: process.env.DATABASE_URL,

  // ER Threads (dispute threads) monitor
  DISPUTE_THREADS_CHANNEL_ID:
    process.env.DISPUTE_THREADS_CHANNEL_ID || "964000735073284127",
  VERIFIERS_ALERTS_CHANNEL_ID:
    process.env.VERIFIERS_ALERTS_CHANNEL_ID || "1485660555879383211",
  VOTING_DISCUSSION_CHANNEL_ID:
    process.env.VOTING_DISCUSSION_CHANNEL_ID || "719352532354465833",
  FOUR_DAYS_IN_MS: 4 * 24 * 60 * 60 * 1000,

  // Proposal requests system
  PROPOSAL_REQUESTS_CHANNEL_ID:
    process.env.PROPOSAL_REQUESTS_CHANNEL_ID || "1423039184184279282",

  // Admin access: Administrator permission or this role
  RISK_LABS_ROLE_ID: process.env.RISK_LABS_ROLE_ID || "1123485195694256158",

  // Runtime settings stored in the DB `settings` table. These are the
  // defaults applied when a key has not been configured via /pr-admin.
  DEFAULT_SETTINGS: {
    credit_window_hours: "24",
    max_active_per_user: "5",
    daily_request_limit: "10",
    poll_interval_minutes: "5",
    dashboard_channel_id: "",
    dashboard_message_id: "",
  },

  // Whitelist qualification thresholds (mirror of the official rules)
  QUALIFY_MIN_SETTLED: 5,
  QUALIFY_MIN_ACCURACY: 0.95,
};
