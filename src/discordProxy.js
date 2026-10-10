// Scoped Discord REST proxy for the voter-dapp (vote.uma.xyz).
// Explicitly authorized by the UMA team (Tony) as a temporary bridge while
// the voter-dapp bot's Message Content intent review is pending.
//
// Their comments pipeline fetches dispute-thread messages via plain Discord
// REST, but their bot lost the Message Content intent and now receives empty
// content. This proxy lends them OUR bot's read access with a hard scope:
// GET channels/{id}/messages only, and only for the dispute-threads channel
// or threads inside it. Content transits — nothing is stored on our side.
// Disable by removing ER_PROXY_API_KEY.
const crypto = require("crypto");
const { DISCORD_TOKEN, DISPUTE_THREADS_CHANNEL_ID } = require("./config");

const API_KEY = process.env.ER_PROXY_API_KEY || "";
const DISCORD_API = "https://discord.com/api/v10";

// Rate-limit headers their retry/backoff logic reads — forwarded verbatim
const FORWARDED_HEADERS = [
  "content-type",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-reset-after",
  "x-ratelimit-bucket",
  "x-ratelimit-global",
  "x-ratelimit-scope",
];

// channelId -> { allowed, expires }. Denials cached shorter so a just-created
// thread isn't blocked for long.
const scopeCache = new Map();
const ALLOW_TTL_MS = 10 * 60 * 1000;
const DENY_TTL_MS = 60 * 1000;

function keyMatches(supplied) {
  const a = Buffer.from(String(supplied || ""));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function isAllowedChannel(client, channelId) {
  if (channelId === DISPUTE_THREADS_CHANNEL_ID) return true;

  const cached = scopeCache.get(channelId);
  if (cached && cached.expires > Date.now()) return cached.allowed;

  let allowed = false;
  try {
    const channel = await client.channels.fetch(channelId);
    allowed = !!channel?.isThread?.() && channel.parentId === DISPUTE_THREADS_CHANNEL_ID;
  } catch {
    allowed = false;
  }
  scopeCache.set(channelId, {
    allowed,
    expires: Date.now() + (allowed ? ALLOW_TTL_MS : DENY_TTL_MS),
  });
  return allowed;
}

function registerDiscordProxy(app, client) {
  if (!API_KEY) {
    console.log("[Proxy] ER_PROXY_API_KEY not set — Discord proxy disabled.");
    return;
  }

  app.get("/discord-proxy/channels/:channelId/messages", async (req, res) => {
    try {
      const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!keyMatches(supplied)) {
        return res.status(401).json({ error: "unauthorized" });
      }

      const channelId = String(req.params.channelId);
      if (!/^\d{17,20}$/.test(channelId)) {
        return res.status(400).json({ error: "invalid channel id" });
      }
      if (!(await isAllowedChannel(client, channelId))) {
        return res.status(403).json({
          error: "channel out of scope: only the dispute-threads channel and its threads are served",
        });
      }

      // Whitelist the exact query surface their pagination uses
      const params = new URLSearchParams();
      const limit = parseInt(req.query.limit, 10);
      if (!Number.isNaN(limit)) {
        params.set("limit", String(Math.min(Math.max(limit, 1), 100)));
      }
      for (const name of ["before", "after"]) {
        const value = req.query[name];
        if (value !== undefined) {
          if (!/^\d{17,20}$/.test(String(value))) {
            return res.status(400).json({ error: `invalid ${name} id` });
          }
          params.set(name, String(value));
        }
      }

      const qs = params.toString();
      const upstream = await fetch(
        `${DISCORD_API}/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
        {
          headers: {
            Authorization: `Bot ${DISCORD_TOKEN}`,
            "User-Agent": "DiscordBot (https://uma.xyz, UMABot er-proxy/1.0)",
          },
        },
      );

      for (const name of FORWARDED_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      const body = await upstream.text();
      console.log(`[Proxy] ${channelId}/messages${qs ? `?${qs}` : ""} → ${upstream.status}`);
      return res.status(upstream.status).send(body);
    } catch (err) {
      console.error("[Proxy] Error:", err.message);
      return res.status(502).json({ error: "upstream error" });
    }
  });

  console.log("[Proxy] Discord dispute-threads proxy enabled at /discord-proxy.");
}

module.exports = { registerDiscordProxy };
