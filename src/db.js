// db.js — Postgres schema + data-access helpers.
//
// Every function here is ASYNC (the old better-sqlite3 layer was synchronous).
// AI columns are nullable so the tool works fully without any AI configured;
// ai_themes is JSONB so themes stay queryable rather than being an opaque string.

// Loaded here as well as in server.js: the pool is built at module load, so .env has
// to be read before this file is evaluated — including when run directly (init-db).
import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn('WARNING: DATABASE_URL is not set — every query will fail.');
}

// Managed Postgres (Supabase, Neon, Render, RDS…) requires TLS but usually presents
// a cert Node won't chain to a public root. PGSSL=disable for a local server.
const sslDisabled = process.env.PGSSL === 'disable' || /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslDisabled ? false : { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX || 10),
});

pool.on('error', (e) => console.error('Postgres pool error:', e.message));

// Small helpers so call sites read like the old ones.
const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

// Run fn inside a transaction on a single dedicated connection.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      slack_user_id TEXT UNIQUE,
      display_name  TEXT,
      access_token  TEXT,        -- per-user Slack user token (xoxp), from OAuth
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Opaque session ids the extension holds after signing in with Slack.
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Short-lived handoff for the tab-based OAuth flow: Slack redirects the browser
    -- to our callback, which parks the result here under the random state value until
    -- the extension polls for it. Rows are one-shot and expire.
    CREATE TABLE IF NOT EXISTS pending_auth (
      state         TEXT PRIMARY KEY,
      session_id    TEXT,
      display_name  TEXT,
      slack_user_id TEXT,
      error         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- A user's linked Jira account. Atlassian access tokens expire in ~1 hour, so the
    -- refresh token is what actually keeps the connection alive; expires_at tells us
    -- when to use it. story_points_field is discovered per site (the custom field id
    -- differs between Jira instances).
    CREATE TABLE IF NOT EXISTS jira_connections (
      user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      cloud_id           TEXT NOT NULL,
      site_url           TEXT,
      site_name          TEXT,
      account_id         TEXT,
      display_name       TEXT,
      access_token       TEXT NOT NULL,
      refresh_token      TEXT,
      expires_at         TIMESTAMPTZ,
      story_points_field TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Ties an in-flight Jira OAuth round trip back to the user who started it: the
    -- callback arrives from Atlassian with no session of ours, so the random state is
    -- the only link. Rows are short-lived.
    CREATE TABLE IF NOT EXISTS jira_auth_pending (
      state      TEXT PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      done       BOOLEAN NOT NULL DEFAULT FALSE,
      error      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS daily_logs (
      id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
      date              DATE NOT NULL,
      slack_channel_id  TEXT,
      slack_thread_ts   TEXT,
      start_post_ts     TEXT,
      finish_post_ts    TEXT,
      mood              INTEGER,      -- 1..5 from the smiley picker (nullable)
      achievements_text TEXT,
      ai_summary        TEXT,         -- nullable: only set if AI enabled
      ai_sentiment      TEXT,         -- nullable
      ai_themes         JSONB,        -- nullable, queryable
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- One row per user per day; the upserts below depend on this.
      UNIQUE (user_id, date)
    );

    CREATE TABLE IF NOT EXISTS log_items (
      id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      daily_log_id      INTEGER REFERENCES daily_logs(id) ON DELETE CASCADE,
      text              TEXT NOT NULL,
      source            TEXT DEFAULT 'morning',   -- 'morning' | 'carried_over' | 'added_at_*'
      status            TEXT DEFAULT 'not_done',  -- 'done' | 'in_progress' | 'not_done' | NULL (headers)
      "order"           INTEGER DEFAULT 0,
      depth             INTEGER DEFAULT 0,        -- nesting level (0 = top bullet)
      is_header         BOOLEAN DEFAULT FALSE,    -- category label with children (not a task)
      ai_category       TEXT,                     -- nullable
      carried_over_from INTEGER
    );

    CREATE TABLE IF NOT EXISTS raw_slack_messages (
      id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      daily_log_id INTEGER REFERENCES daily_logs(id) ON DELETE CASCADE,
      kind         TEXT,        -- 'start' | 'finish'
      text         TEXT,
      slack_ts     TEXT,
      permalink    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date ON daily_logs (user_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_log_items_log ON log_items (daily_log_id, "order");
    CREATE INDEX IF NOT EXISTS idx_pending_auth_created ON pending_auth (created_at);
  `);
  console.log('Schema ready on Postgres');
}

export async function upsertUser(slackUserId, displayName) {
  return one(
    `INSERT INTO users (slack_user_id, display_name) VALUES ($1, $2)
     ON CONFLICT (slack_user_id) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING *`,
    [slackUserId, displayName]
  );
}

// Store/refresh a user's OAuth token and return the user row.
export async function saveUserToken(slackUserId, displayName, accessToken) {
  return one(
    `INSERT INTO users (slack_user_id, display_name, access_token) VALUES ($1, $2, $3)
     ON CONFLICT (slack_user_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       access_token = EXCLUDED.access_token
     RETURNING *`,
    [slackUserId, displayName, accessToken]
  );
}

// Create an opaque session for a user; the extension stores and replays this id.
export async function createSession(userId) {
  const id = 'sess_' + randomUUID().replace(/-/g, '');
  await query('INSERT INTO sessions (id, user_id) VALUES ($1, $2)', [id, userId]);
  return id;
}

// --- tab-based OAuth handoff ---

// Park a finished (or failed) sign-in under its state, for the extension to collect.
export async function savePendingAuth(state, payload) {
  await query(`DELETE FROM pending_auth WHERE created_at < now() - interval '10 minutes'`);
  await query(
    `INSERT INTO pending_auth (state, session_id, display_name, slack_user_id, error)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (state) DO UPDATE SET
       session_id = EXCLUDED.session_id, display_name = EXCLUDED.display_name,
       slack_user_id = EXCLUDED.slack_user_id, error = EXCLUDED.error`,
    [state, payload.sessionId || null, payload.displayName || null,
     payload.slackUserId || null, payload.error || null]
  );
}

// Read-and-delete in one statement: a state is good for exactly one collection.
export async function takePendingAuth(state) {
  if (!state) return null;
  return one(
    `DELETE FROM pending_auth
      WHERE state = $1 AND created_at >= now() - interval '10 minutes'
      RETURNING *`,
    [state]
  );
}

// Resolve the user (incl. their access_token) from a session id.
export async function getUserBySession(sessionId) {
  if (!sessionId) return null;
  return one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [sessionId]
  );
}

// --- Jira connection ---

export async function saveJiraConnection(userId, conn) {
  return one(
    `INSERT INTO jira_connections
       (user_id, cloud_id, site_url, site_name, account_id, display_name,
        access_token, refresh_token, expires_at, story_points_field)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id) DO UPDATE SET
       cloud_id = EXCLUDED.cloud_id, site_url = EXCLUDED.site_url,
       site_name = EXCLUDED.site_name, account_id = EXCLUDED.account_id,
       display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, jira_connections.refresh_token),
       expires_at = EXCLUDED.expires_at,
       story_points_field = COALESCE(EXCLUDED.story_points_field, jira_connections.story_points_field),
       updated_at = now()
     RETURNING *`,
    [userId, conn.cloudId, conn.siteUrl || null, conn.siteName || null,
     conn.accountId || null, conn.displayName || null, conn.accessToken,
     conn.refreshToken || null, conn.expiresAt || null, conn.storyPointsField || null]
  );
}

export async function getJiraConnection(userId) {
  return one('SELECT * FROM jira_connections WHERE user_id = $1', [userId]);
}

export async function deleteJiraConnection(userId) {
  await query('DELETE FROM jira_connections WHERE user_id = $1', [userId]);
}

// Written after a token refresh — the refresh token itself may rotate.
export async function updateJiraTokens(userId, { accessToken, refreshToken, expiresAt }) {
  await query(
    `UPDATE jira_connections
        SET access_token = $2,
            refresh_token = COALESCE($3, refresh_token),
            expires_at = $4,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, accessToken, refreshToken || null, expiresAt || null]
  );
}

export async function setJiraStoryPointsField(userId, fieldId) {
  await query('UPDATE jira_connections SET story_points_field = $2, updated_at = now() WHERE user_id = $1',
    [userId, fieldId]);
}

// --- Jira OAuth handshake state ---

export async function createJiraAuthState(state, userId) {
  await query(`DELETE FROM jira_auth_pending WHERE created_at < now() - interval '15 minutes'`);
  await query('INSERT INTO jira_auth_pending (state, user_id) VALUES ($1, $2)', [state, userId]);
}

// Read without consuming — the callback needs to know whose connection this is.
export async function getJiraAuthState(state) {
  if (!state) return null;
  return one(
    `SELECT * FROM jira_auth_pending
      WHERE state = $1 AND created_at >= now() - interval '15 minutes'`,
    [state]
  );
}

export async function finishJiraAuthState(state, error = null) {
  await query('UPDATE jira_auth_pending SET done = TRUE, error = $2 WHERE state = $1', [state, error]);
}

// Polled by the extension; consumes the row once the callback has finished.
export async function takeJiraAuthResult(state) {
  if (!state) return null;
  const row = await getJiraAuthState(state);
  if (!row || !row.done) return null;
  await query('DELETE FROM jira_auth_pending WHERE state = $1', [state]);
  return row;
}

// Replace a day's items wholesale — the submitted list is always authoritative.
async function replaceItems(client, logId, items) {
  await client.query('DELETE FROM log_items WHERE daily_log_id = $1', [logId]);
  for (const [i, it] of items.entries()) {
    await client.query(
      `INSERT INTO log_items (daily_log_id, text, source, status, "order", depth, is_header)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        logId, it.text, it.source || 'morning',
        it.isHeader ? null : (it.status || 'not_done'),
        i, it.depth || 0, !!it.isHeader,
      ]
    );
  }
}

// Record the "before you start work" post at check-in. Returns the daily_log id.
// One row per user per day: check-in creates it, check-out fills it in.
export async function saveStartLog(payload) {
  const { user_id, date, slack_channel_id, slack_thread_ts = null, start_post_ts, items = [] } = payload;
  return tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO daily_logs (user_id, date, slack_channel_id, slack_thread_ts, start_post_ts)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, date) DO UPDATE SET
         slack_channel_id = EXCLUDED.slack_channel_id,
         slack_thread_ts  = EXCLUDED.slack_thread_ts,
         start_post_ts    = EXCLUDED.start_post_ts
       RETURNING id`,
      [user_id, date, slack_channel_id, slack_thread_ts, start_post_ts]
    );
    const logId = rows[0].id;
    await replaceItems(client, logId, items);
    return logId;
  });
}

// A day's stored record plus its items — used to recognise a start-work post we
// made ourselves, without waiting for Slack's search index to catch up.
export async function getDayLog(user_id, date) {
  const log = await one('SELECT * FROM daily_logs WHERE user_id = $1 AND date = $2', [user_id, date]);
  if (!log) return null;
  const items = await all(
    `SELECT text, status, "order", depth, is_header, source
       FROM log_items WHERE daily_log_id = $1 ORDER BY "order"`,
    [log.id]
  );
  return { ...log, items: items.map((i) => ({ ...i, isHeader: !!i.is_header })) };
}

// Save a full day's record in one transaction. Returns the daily_log id.
export async function saveDailyLog(payload) {
  const {
    user_id, date, slack_channel_id, slack_thread_ts,
    start_post_ts, finish_post_ts, mood, achievements_text,
    ai_summary = null, ai_sentiment = null, ai_themes = null,
    items = [],
  } = payload;

  return tx(async (client) => {
    // Check-in may already have created today's row — update it rather than
    // inserting a second row for the same date. COALESCE keeps the start post ts
    // that check-in wrote when this call doesn't carry one.
    const { rows } = await client.query(
      `INSERT INTO daily_logs
         (user_id, date, slack_channel_id, slack_thread_ts, start_post_ts,
          finish_post_ts, mood, achievements_text, ai_summary, ai_sentiment, ai_themes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, date) DO UPDATE SET
         slack_channel_id  = EXCLUDED.slack_channel_id,
         slack_thread_ts   = EXCLUDED.slack_thread_ts,
         start_post_ts     = COALESCE(EXCLUDED.start_post_ts, daily_logs.start_post_ts),
         finish_post_ts    = EXCLUDED.finish_post_ts,
         mood              = EXCLUDED.mood,
         achievements_text = EXCLUDED.achievements_text,
         ai_summary        = EXCLUDED.ai_summary,
         ai_sentiment      = EXCLUDED.ai_sentiment,
         ai_themes         = EXCLUDED.ai_themes
       RETURNING id`,
      [user_id, date, slack_channel_id, slack_thread_ts, start_post_ts,
       finish_post_ts, mood, achievements_text, ai_summary, ai_sentiment,
       ai_themes ? JSON.stringify(ai_themes) : null]
    );
    const logId = rows[0].id;
    await replaceItems(client, logId, items);
    return logId;
  });
}

// Allow running `node src/db.js` to initialize the database.
if (import.meta.url === `file://${process.argv[1]}`) {
  await initSchema();
  await pool.end();
}
