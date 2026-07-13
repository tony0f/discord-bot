const express = require("express");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const db = require("./db");
const pr = require("./proposalRequests");

const PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_SECRET =
  process.env.DASHBOARD_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE_NAME = "pr_session";
const SESSION_TTL = "12h";

// Simple in-memory login rate limit: 5 failures per IP per 15 minutes
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > 15 * 60 * 1000) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.count >= 5;
}
function recordFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, first: Date.now() };
  entry.count++;
  loginAttempts.set(ip, entry);
}

function requireAuth(req, res, next) {
  try {
    const token = req.cookies[COOKIE_NAME];
    jwt.verify(token, SESSION_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

function start(client) {
  if (!db.isEnabled()) {
    console.warn("[Web] Database disabled — dashboard not started.");
    return;
  }
  if (!PASSWORD) {
    console.warn("[Web] DASHBOARD_PASSWORD not set — dashboard not started.");
    return;
  }
  if (!process.env.DASHBOARD_SESSION_SECRET) {
    console.warn("[Web] DASHBOARD_SESSION_SECRET not set — sessions will not survive restarts.");
  }

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());

  // ---- Auth ----
  app.post("/api/login", (req, res) => {
    const ip = req.ip;
    if (tooManyAttempts(ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    }
    const supplied = String(req.body?.password || "");
    const ok =
      supplied.length === PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(PASSWORD));
    if (!ok) {
      recordFailure(ip);
      return res.status(401).json({ error: "Wrong password." });
    }
    loginAttempts.delete(ip);
    const token = jwt.sign({ role: "admin" }, SESSION_SECRET, { expiresIn: SESSION_TTL });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV !== "development",
      maxAge: 12 * 60 * 60 * 1000,
    });
    return res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.json({ ok: true });
  });

  app.get("/api/me", requireAuth, (req, res) => res.json({ role: "admin" }));

  // ---- Data ----
  app.get("/api/overview", requireAuth, async (req, res, next) => {
    try {
      const [statusCounts, daily, topUsers, globals] = await Promise.all([
        db.query(
          `SELECT status, COUNT(*)::int AS count FROM proposal_requests GROUP BY status`,
        ),
        db.query(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                  COUNT(*)::int AS created,
                  COUNT(*) FILTER (WHERE status = 'settled_correct')::int AS correct,
                  COUNT(*) FILTER (WHERE status = 'settled_incorrect')::int AS incorrect,
                  COUNT(*) FILTER (WHERE status = 'expired')::int AS expired
           FROM proposal_requests
           WHERE created_at > now() - interval '30 days'
           GROUP BY 1 ORDER BY 1`,
        ),
        db.query(
          `SELECT discord_username AS username, COUNT(*)::int AS requests
           FROM proposal_requests
           WHERE status <> 'invalidated'
           GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        ),
        db.query(
          `SELECT COUNT(DISTINCT discord_user_id)::int AS users,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status = 'settled_correct'
                    AND settled_at > now() - interval '6 months')::int AS correct_6m,
                  COUNT(*) FILTER (WHERE status = 'settled_incorrect'
                    AND settled_at > now() - interval '6 months')::int AS incorrect_6m
           FROM proposal_requests`,
        ),
      ]);
      const g = globals.rows[0];
      const settled = g.correct_6m + g.incorrect_6m;
      res.json({
        statusCounts: statusCounts.rows,
        daily: daily.rows,
        topUsers: topUsers.rows,
        totals: {
          users: g.users,
          requests: g.total,
          settled6m: settled,
          accuracy6m: settled > 0 ? g.correct_6m / settled : null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/requests", requireAuth, async (req, res, next) => {
    try {
      const { status, search } = req.query;
      const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const where = [];
      const params = [];
      if (status && status !== "all") {
        params.push(status);
        where.push(`status = $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        where.push(
          `(market_question ILIKE $${params.length} OR discord_username ILIKE $${params.length} OR id::text = '${parseInt(search, 10) || 0}')`,
        );
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [rows, count] = await Promise.all([
        db.query(
          `SELECT * FROM proposal_requests ${whereSql}
           ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        db.query(`SELECT COUNT(*)::int AS n FROM proposal_requests ${whereSql}`, params),
      ]);
      const reportsMap = await pr.getReportsMap(rows.rows.map((r) => r.id));
      res.json({
        total: count.rows[0].n,
        requests: rows.rows.map((r) => ({ ...r, reports: reportsMap[r.id] || [] })),
      });
    } catch (err) {
      next(err);
    }
  });

  // Actions also sync the Discord card + live board
  async function syncDiscord(requestId) {
    try {
      const { editRequestMessage, refreshDashboard } = require("./watcher");
      const request = await pr.getRequestById(requestId);
      if (request) await editRequestMessage(client, request);
      await refreshDashboard(client);
    } catch (err) {
      console.warn("[Web] Discord sync failed:", err.message);
    }
  }

  app.post("/api/requests/:id/invalidate", requireAuth, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ error: "Reason is required." });
      const request = await pr.getRequestById(id);
      if (!request) return res.status(404).json({ error: "Request not found." });
      if (["settled_correct", "settled_incorrect"].includes(request.status)) {
        return res.status(409).json({ error: "Settled requests cannot be invalidated." });
      }
      const updated = await pr.invalidateRequest(id, reason);
      syncDiscord(id);
      res.json({ ok: true, request: updated });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/requests/:id/warnings", requireAuth, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const reason = String(req.body?.reason || "").trim();
      if (!reason) return res.status(400).json({ error: "Reason is required." });
      const request = await pr.getRequestById(id);
      if (!request) return res.status(404).json({ error: "Request not found." });
      try {
        await db.query(
          `INSERT INTO request_reports (request_id, reporter_id, reporter_username, reason)
           VALUES ($1, 'dashboard-admin', 'Admin (dashboard)', $2)`,
          [id, reason],
        );
      } catch (err) {
        if (err.code === "23505") {
          return res.status(409).json({ error: "The dashboard already added a warning to this request." });
        }
        throw err;
      }
      syncDiscord(id);
      res.json({ ok: true, reports: await pr.getReports(id) });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/requests/:id/warnings", requireAuth, async (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      const request = await pr.getRequestById(id);
      if (!request) return res.status(404).json({ error: "Request not found." });
      await pr.clearReports(id);
      syncDiscord(id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/leaderboard", requireAuth, async (req, res, next) => {
    try {
      res.json({ leaderboard: await pr.getLeaderboard(50) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/settings", requireAuth, async (req, res, next) => {
    try {
      res.json({ settings: await db.getSettings() });
    } catch (err) {
      next(err);
    }
  });

  const EDITABLE_SETTINGS = new Set([
    "credit_window_hours",
    "max_active_per_user",
    "daily_request_limit",
    "poll_interval_minutes",
  ]);
  app.put("/api/settings", requireAuth, async (req, res, next) => {
    try {
      const updates = req.body || {};
      for (const [key, value] of Object.entries(updates)) {
        if (!EDITABLE_SETTINGS.has(key)) {
          return res.status(400).json({ error: `Setting "${key}" is not editable.` });
        }
        const n = parseInt(value, 10);
        if (Number.isNaN(n) || n < 1 || n > 10000) {
          return res.status(400).json({ error: `Invalid value for ${key}.` });
        }
        await db.setSetting(key, n);
      }
      res.json({ settings: await db.getSettings() });
    } catch (err) {
      next(err);
    }
  });

  // ---- Static dashboard ----
  const distDir = path.join(__dirname, "..", "dashboard", "dist");
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(distDir, "index.html"), (err) => {
      if (err) res.status(404).send("Dashboard build not found. Run: npm run build");
    });
  });

  app.use((err, req, res, _next) => {
    console.error("[Web] API error:", err);
    res.status(500).json({ error: "Internal error." });
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[Web] Dashboard listening on :${port}`));
}

module.exports = { start };
