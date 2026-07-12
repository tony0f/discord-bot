# UMA Helper Bot for Discord

A Discord bot for the UMA server with two jobs:

1. **ER Threads monitor** — enforces participation rules in the dispute-threads channel.
2. **Proposal Requests** — a merit-tracking system that gives non-whitelisted users a measurable path into the [UMA proposer whitelist](https://docs.uma.xyz/using-uma/default-proposer-whitelist) by formally requesting market proposals instead of proposing on-chain.

## 1. ER Threads monitor

The bot watches every thread under the ER Threads channel (first 4 days of each thread) and detects:

* **Replying** to another message inside a dispute thread.
* **Posting more than one message** in the same thread.

Violations trigger an alert in **verifiers-alerts** and a public warning mentioning the user in **voting-discussion**. On startup (e.g., a Railway restart) the bot re-scans active threads and de-duplicates against its recent alerts.

## 2. Proposal Requests

Since almost no OOV2 markets remain, users can no longer build the 5-proposals/95%-accuracy record the whitelist requires. This system replicates that record using **requests**:

1. A user runs **`/request link:<Polymarket URL>`**. The bot queries the Gamma API on the spot and opens a dynamic modal: if the link is an event with brackets (e.g. "What will Elon post this week"), a **dropdown lists only the requestable brackets** (already resolved/proposed/requested ones are hidden) with multi-select support; the outcome is a dropdown too (Yes/No/50-50 or the market's real outcomes). Evidence (optional — proving a "No" often has no link; up to 4000 chars, long evidence is posted in full inside the discussion thread) and an optional wallet complete the form.
2. The bot validates the request:
   * The market exists, is not closed/resolved, and **has no on-chain proposal yet**.
   * The outcome matches the market's outcomes (`Yes`, `No`, team names, `50-50`, `p1`/`p2` shorthand).
   * Nobody else has an active request for the market — **first come, first served**.
   * The user is within their active-requests and daily limits, and hasn't already met the whitelist criteria.
3. The request is published as a card in **#proposal-requests** with a discussion thread.
4. A watcher polls the Polymarket Gamma API and moves each request through its lifecycle:
   * **`proposed`** — a whitelisted proposer proposed the market within the **credit window** (default 24h, configurable).
   * **`settled_correct` / `settled_incorrect`** — the market resolved matching (or not) the requested outcome.
   * **`expired`** — nobody proposed within the window → no credit. This is the main protection against spam and too-early (P4) farming.
5. Stats accumulate per user over a rolling 6 months. Reaching **5+ settled requests with ≥95% accuracy** flags the user as whitelist-qualified (and closes new requests for them).

**Community moderation:** anyone can `/report` an active request they believe is bad-faith — multiple users can each add one warning per request. The card turns red with a **🚨 COMMUNITY WARNINGS (N)** banner listing every reporter and reason chronologically, the live board shows them (🚩×N badge), and each report is announced publicly under the card. Admins then either `/pr-admin invalidate` the request (it never counts) or `/pr-admin clear_flag` to remove all warnings if they don't hold. **Early-resolution claims** (market end time still in the future) are allowed — per UMA rules a market is proposable as soon as its event occurs — but the card carries a ⚠️ note telling proposers to verify the evidence with extra care.

### Commands

| Command | Who | What |
|---|---|---|
| `/request link:` | everyone | Open the dynamic request form for a Polymarket link |
| `/mystats` | everyone | Your record and whitelist progress (ephemeral) |
| `/leaderboard` | everyone | Top requesters, last 6 months |
| `/requests` | everyone | List all active requests (pending/proposed), public |
| `/report id: reason:` | everyone | Add a community warning to a bad-faith request |
| `/pr-admin view_settings` | admins | Show runtime settings |
| `/pr-admin set_credit_window hours:` | admins | Hours before an unproposed request expires |
| `/pr-admin set_max_active value:` | admins | Max simultaneous active requests per user |
| `/pr-admin set_daily_limit value:` | admins | Max requests per user per 24h |
| `/pr-admin set_poll_interval minutes:` | admins | Watcher frequency |
| `/pr-admin set_dashboard_channel channel:` | admins | Where the auto-updating live board lives |
| `/pr-admin invalidate id: reason:` | admins | Kill a spam/bad-faith request |
| `/pr-admin clear_flag id:` | admins | Remove a community warning |
| `/pr-admin user_stats user:` | admins | Inspect any user's record |

Admins = Administrator permission or the Risk Labs role.

## Setup

### Prerequisites

* Node.js **>= 18**
* A Postgres database (on Railway: add the Postgres plugin; it injects `DATABASE_URL`)
* Discord bot with the **Message Content** privileged intent

### Install & configure

```bash
npm install
```

`.env`:

```env
DISCORD_TOKEN=your-bot-token
DATABASE_URL=postgres://...        # required for proposal requests
BOT_ID=your-application-client-id  # for deploy_commands.js
GUILD_ID=your-guild-id             # optional: instant command propagation while testing
```

Channel IDs (proposal-requests, ER threads, alerts) have hardcoded defaults in [src/config.js](src/config.js) and can be overridden via env vars of the same name.

### Run

```bash
node deploy_commands.js   # register /request, /mystats, /leaderboard, /pr-admin
node index.js
```

Without `DATABASE_URL` the bot still runs the ER monitor; proposal-request commands reply with a "not configured" notice.

## Notes

* The DB schema is created automatically on startup (`proposal_requests` + `settings`).
* Gamma API quirk handled in code: slug lookups exclude closed markets by default; the watcher retries with `closed=true` to detect settlements.
* `google-spreadsheet` / `google-auth-library` remain installed for a future read-only export of the records to Google Sheets.
