const { Pool } = require("pg");
const { DATABASE_URL, DEFAULT_SETTINGS } = require("./config");

let pool = null;

function isEnabled() {
  return pool !== null;
}

async function init() {
  if (!DATABASE_URL) {
    console.warn(
      "[DB] DATABASE_URL is not set. Proposal-requests features are DISABLED (ER monitor still runs).",
    );
    return false;
  }

  // Railway's private network (railway.internal) and local dev don't use SSL;
  // public proxy URLs do (self-signed cert, hence rejectUnauthorized: false).
  const noSsl =
    DATABASE_URL.includes("localhost") ||
    DATABASE_URL.includes("127.0.0.1") ||
    DATABASE_URL.includes(".railway.internal");
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: noSsl ? false : { rejectUnauthorized: false },
    max: 5,
  });

  pool.on("error", (err) => {
    console.error("[DB] Unexpected pool error:", err.message);
  });

  try {
    await createSchema();
  } catch (err) {
    await pool.end().catch(() => {});
    pool = null;
    throw err;
  }

  console.log("[DB] Connected and schema ensured.");
  return true;
}

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposal_requests (
      id SERIAL PRIMARY KEY,
      discord_user_id TEXT NOT NULL,
      discord_username TEXT NOT NULL,
      discord_display_name TEXT,
      wallet_address TEXT,
      market_slug TEXT NOT NULL,
      market_question TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      question_id TEXT,
      market_url TEXT NOT NULL,
      outcomes TEXT NOT NULL,
      requested_outcome TEXT NOT NULL,
      evidence TEXT NOT NULL,
      end_date TIMESTAMPTZ,
      early_claim BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      message_id TEXT,
      channel_id TEXT,
      proposed_at TIMESTAMPTZ,
      settled_at TIMESTAMPTZ,
      settled_outcome TEXT,
      invalidated_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Legacy single-flag columns (superseded by request_reports, kept for migration)
  await pool.query(`
    ALTER TABLE proposal_requests
      ADD COLUMN IF NOT EXISTS flag_reason TEXT,
      ADD COLUMN IF NOT EXISTS flagged_by TEXT,
      ADD COLUMN IF NOT EXISTS flagged_by_username TEXT,
      ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;
  `);

  // Community warnings: many per request, at most one per reporter
  await pool.query(`
    CREATE TABLE IF NOT EXISTS request_reports (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES proposal_requests(id) ON DELETE CASCADE,
      reporter_id TEXT NOT NULL,
      reporter_username TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_report_per_user
    ON request_reports (request_id, reporter_id);
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_reports_request ON request_reports (request_id);`,
  );
  // One-time migration of legacy single-flag data
  await pool.query(`
    INSERT INTO request_reports (request_id, reporter_id, reporter_username, reason, created_at)
    SELECT id, flagged_by, flagged_by_username, flag_reason, COALESCE(flagged_at, now())
    FROM proposal_requests
    WHERE flag_reason IS NOT NULL AND flagged_by IS NOT NULL
    ON CONFLICT (request_id, reporter_id) DO NOTHING;
  `);

  // Only one active (pending/proposed) request per market — first come, first served
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_market
    ON proposal_requests (condition_id)
    WHERE status IN ('pending', 'proposed');
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pr_user ON proposal_requests (discord_user_id);`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pr_status ON proposal_requests (status);`,
  );
}

async function query(text, params) {
  if (!pool) throw new Error("Database not initialized");
  return pool.query(text, params);
}

async function getSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  const res = await query(`SELECT key, value FROM settings`);
  for (const row of res.rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)],
  );
}

module.exports = { init, isEnabled, query, getSettings, setSetting };
