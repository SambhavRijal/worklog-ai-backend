# WorkLog AI — backend

Node + Express + Postgres. Serves the [extension](../worklog-ai-extension): finishes the
Slack OAuth handshake, reads and posts to Slack **as each signed-in user**, and stores
the daily log.

There is **no shared Slack token** — every request is attributed to whoever's session
made it, and an unauthenticated request is rejected rather than silently posted as
someone else.

```
src/
  server.js     the HTTP API
  slack.js      everything that talks to Slack
  parse.js      splits posts into items; reads statuses back out
  db.js         SQLite schema + data access
scripts/
  debug-thread.js   diagnose "daily-updates thread not found"
  migrate-sqlite-to-postgres.js  one-time import from the old SQLite file
docs/SLACK_SETUP.md creating the Slack app
```

## Run it

```bash
npm install
# set DATABASE_URL in .env first
npm run init-db     # creates the tables
npm start
```

Any Postgres works — local, Supabase, Neon, RDS. Use the **direct/session** connection
string for a long-lived server, not a transaction pooler.

Sanity check: `curl http://localhost:8787/health`

## Configuration

Copy `.env.example` to `.env` and fill it in. The ones that matter:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string. TLS is enabled automatically for non-localhost hosts; set `PGSSL=disable` to force it off. |
| `PUBLIC_URL` | Where a **browser** can reach this backend. The OAuth redirect is `<PUBLIC_URL>/auth/slack/callback` and must match the Slack app exactly. |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | From the Slack app. The **secret belongs only here** — never in the extension. |
| `START_MARKER` | Phrase identifying a start-work post. |
| `START_HEADER` / `FINISH_HEADER` | Headers when composing. `START_HEADER` **must contain** `START_MARKER`, or check-out can't find what check-in posted (the server warns at startup if not). |
| `THREAD_ANCHOR` | Phrase identifying the daily workflow message everyone replies under. |

`PUBLIC_URL` must equal `BACKEND_URL` in the extension's `src/config.js`.

## API

| Endpoint | Purpose |
|---|---|
| `GET /auth/slack/callback` | Slack redirects here; finishes the OAuth exchange |
| `GET /auth/slack/session` | Extension collects the session for its `state` (one-shot) |
| `GET /day/checkin` | Items still open on the last day worked, + today's thread |
| `POST /day/start` | Posts the start-work message into that thread |
| `GET /day/today` | Today's start-work post + parsed items |
| `POST /day/post` | Posts the finish-work reply, stores the day |

Everything under `/day/*` needs an `X-Session` header and returns **401** without one.

## Slack scopes

`search:read`, `chat:write`, `users:read`, `channels:history`, `groups:history` — all as
**User** token scopes, not Bot. Posts are made as the person, not a bot.

`search:read` requires a **paid** Slack plan.

`channels:history` / `groups:history` let the backend read the daily-updates channel
directly, which is the only way to find today's thread when you're the first to report —
Slack search doesn't reliably index workflow/bot posts and lags several minutes behind.

## Deploying

Anything that runs Node with a persistent disk (the SQLite file holds user tokens). After
deploying, update `PUBLIC_URL` here, plus `BACKEND_URL` and `host_permissions` in the
extension — then re-register the redirect URL in Slack.

Tighten `cors()` in `server.js` to your real origins before exposing it publicly.

## Migrating from the old SQLite build

Carries users (with their Slack tokens, so nobody re-authorises), sessions, and history:

```bash
npm i -D better-sqlite3        # only needed for the migration
node scripts/migrate-sqlite-to-postgres.js /path/to/worklog.db
```

Re-runnable — every insert upserts on a natural key, so a second run updates rather than
duplicating.

Two things to know:

- **Copy the `-wal` file too.** SQLite in WAL mode keeps recent writes in
  `worklog.db-wal`; moving only `worklog.db` silently loses them.
- **Row counts shrink.** `daily_logs` is now `UNIQUE (user_id, date)`, so days that had
  duplicate rows in the old schema collapse into one. That's the fix, not data loss.
