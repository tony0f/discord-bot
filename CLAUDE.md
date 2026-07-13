# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

UMA Helper Bot — a Discord bot for the UMA server with two responsibilities:

1. **ER Threads monitor**: watches the dispute-threads channel; if a user posts twice in the same dispute thread or replies to another message, alerts verifiers-alerts and posts a public warning in voting-discussion.
2. **Proposal Requests system**: lets non-whitelisted users formally request that a whitelisted proposer propose a Polymarket market (`/request`). The bot tracks each request through the market's UMA resolution lifecycle and builds a per-user accuracy record that mirrors the official proposer-whitelist criteria (5+ settled, ≥95% accuracy, 6 months — see https://docs.uma.xyz/using-uma/default-proposer-whitelist).

The bot previously automated ticket recording into Google Sheets for the verification team; that was removed in July 2026 (see git history).

## Commands

```bash
npm install                  # Install dependencies
node index.js                # Run the bot
node deploy_commands.js      # Register slash commands (run after any command change)
```

No build step, test suite, or linter is configured. Node >= 18 required (native `fetch`).

## Architecture

```
index.js                 — client setup, event wiring, startup
src/config.js            — env vars, channel IDs, default settings, thresholds
src/db.js                — pg pool, schema init, settings key/value store
src/polymarket.js        — Polymarket URL parsing + Gamma API + outcome matching
src/proposalRequests.js  — validation pipeline, request CRUD, stats, leaderboard
src/embeds.js            — request card + live board embeds
src/interactions.js      — slash commands + /request modal handlers
src/watcher.js           — polling loop: expiry, proposal/settlement detection, live board
src/disputeMonitor.js    — ER Threads monitor (real-time + startup scan + cache cleanup)
```

### Proposal request lifecycle

```
/request → validation → pending → proposed → settled_correct | settled_incorrect
                ↘ rejected             ↘ (reset on-chain → back to pending)
           pending → expired (no proposal within the credit window)
           any active → invalidated (admin)
```

Validation gates (src/proposalRequests.js `createRequest`): user not already qualified, active/daily limits, market resolves via Gamma, not closed/resolved, **no existing on-chain proposal**, outcome matches the market's outcomes, no active request for the same `conditionId` (first-come-first-served, enforced by a partial unique index).

Key anti-abuse mechanic: the **credit window** (default 24h, `/pr-admin set_credit_window`). A request only counts if a proposal lands within the window; too-early (P4) or junk requests simply expire with no credit. Early claims (market end time still in the future) are allowed but flagged `early_claim`.

### Gamma API notes (verified against the live API)

- `umaResolutionStatus`: `""` → no proposal, `"proposed"`/`"challenged"`/`"reproposed"`/`"disputed"` → proposal exists, `"resolved"` → settled.
- On resolution, `outcomePrices` snap to `"1"`/`"0"` (winner) or `"0.5"`/`"0.5"` (50-50).
- **Slug lookups exclude closed markets by default** — `fetchMarketBySlug` retries with `closed=true`; without this the watcher would never see settlements.
- `outcomes`/`outcomePrices` are JSON-encoded strings, not arrays.

### Data storage

Postgres via `DATABASE_URL` (Railway plugin). Two tables: `settings` (key/value runtime config, editable via `/pr-admin`) and `proposal_requests`. If `DATABASE_URL` is missing, the bot still runs the ER monitor and replies to PR commands with a "not configured" notice.

### Configuration

- **`.env`**: `DISCORD_TOKEN` (required), `DATABASE_URL` (required for proposal requests), `BOT_ID`/`GUILD_ID` (deploy_commands only). Channel IDs have hardcoded defaults in src/config.js, overridable via env.
- **Runtime settings** (DB, via `/pr-admin`): credit window, max active per user, daily limit, poll interval, dashboard channel.

### Slash commands

`/request link:<url>` has two flows. **Single market link** → a modal (must be shown within Discord's 3s window — the Gamma lookup runs with a 2.2s timeout) with the market's real outcomes (+50-50) as a select plus an optional evidence input. **Event link** → a deferred ephemeral picker where every requestable line×outcome pair is its own option (up to 4 multi-selects / 100 options; each bracket re-verified via a bulk full-market fetch because nested event statuses can be stale), then a Continue button (blocks if multiple outcomes are selected for the same market) opens the evidence modal. Uses discord.js modal Label components (`ModalBuilder.addLabelComponents` + `LabelBuilder.setStringSelectMenuComponent`, read via `fields.getStringSelectValues`) — requires discord.js >= 14.22. Form/session context is stashed in an in-memory `pendingForms` map keyed by the command interaction id (15 min TTL); a bot restart between open and submit invalidates the form gracefully. No wallet is collected (deliberately — no promises about whitelist inclusion); the `wallet_address` DB column remains but is always null.

`/mystats`, `/leaderboard`, `/pr-admin` (admin: Administrator permission, Risk Labs role, or an ID in `ADMIN_USER_IDS`; hidden from non-admins via default member permissions).

## Deployment

Railway. Restarts are expected: the ER monitor rebuilds its cache on startup, and all proposal-request state lives in Postgres.
