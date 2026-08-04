// db.js — SQLite schema + tiny data-access helpers.
// The schema matches the proposal's data model. AI columns are nullable so the
// tool works fully without any AI configured.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'worklog.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slack_user_id TEXT UNIQUE,
      display_name  TEXT,
      access_token  TEXT,        -- per-user Slack user token (xoxp), from OAuth
      created_at    TEXT DEFAULT (datetime('now'))
    );

    -- Opaque session ids the extension holds after signing in with Slack.
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Short-lived handoff for the tab-based OAuth flow: Slack redirects the browser
    -- to our callback, which parks the result here under the random state value until
    -- the extension polls for it. Rows are one-shot and expire.
    CREATE TABLE IF NOT EXISTS pending_auth (
      state        TEXT PRIMARY KEY,
      session_id   TEXT,
      display_name TEXT,
      slack_user_id TEXT,
      error        TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_logs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER REFERENCES users(id),
      date             TEXT NOT NULL,
      slack_channel_id TEXT,
      slack_thread_ts  TEXT,
      start_post_ts    TEXT,
      finish_post_ts   TEXT,
      mood             INTEGER,          -- 1..5 from the smiley picker (nullable)
      achievements_text TEXT,
      ai_summary       TEXT,             -- nullable: only set if AI enabled
      ai_sentiment     TEXT,             -- nullable
      ai_themes        TEXT,             -- nullable JSON
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS log_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      daily_log_id      INTEGER REFERENCES daily_logs(id),
      text              TEXT NOT NULL,
      source            TEXT DEFAULT 'morning',   -- 'morning' | 'added_at_checkout'
      status            TEXT DEFAULT 'not_done',  -- 'done' | 'in_progress' | 'not_done' | null (headers)
      "order"           INTEGER DEFAULT 0,
      depth             INTEGER DEFAULT 0,        -- nesting level (0 = top bullet)
      is_header         INTEGER DEFAULT 0,        -- 1 = category label with children (not a task)
      ai_category       TEXT,                     -- nullable
      carried_over_from INTEGER
    );

    CREATE TABLE IF NOT EXISTS raw_slack_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      daily_log_id INTEGER REFERENCES daily_logs(id),
      kind         TEXT,        -- 'start' | 'finish'
      text         TEXT,
      slack_ts     TEXT,
      permalink    TEXT
    );
  `);
  // Defensive migration for DBs created before depth/is_header existed.
  for (const col of ['depth INTEGER DEFAULT 0', 'is_header INTEGER DEFAULT 0']) {
    try { db.exec(`ALTER TABLE log_items ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
  console.log('Schema ready at', DB_PATH);
}

export function upsertUser(slackUserId, displayName) {
  db.prepare(
    `INSERT INTO users (slack_user_id, display_name) VALUES (?, ?)
     ON CONFLICT(slack_user_id) DO UPDATE SET display_name = excluded.display_name`
  ).run(slackUserId, displayName);
  return db.prepare('SELECT * FROM users WHERE slack_user_id = ?').get(slackUserId);
}

// Store/refresh a user's OAuth token and return the user row.
export function saveUserToken(slackUserId, displayName, accessToken) {
  db.prepare(
    `INSERT INTO users (slack_user_id, display_name, access_token) VALUES (?, ?, ?)
     ON CONFLICT(slack_user_id) DO UPDATE SET
       display_name = excluded.display_name,
       access_token = excluded.access_token`
  ).run(slackUserId, displayName, accessToken);
  return db.prepare('SELECT * FROM users WHERE slack_user_id = ?').get(slackUserId);
}

// Create an opaque session for a user; the extension stores and replays this id.
export function createSession(userId) {
  const id = 'sess_' + randomUUID().replace(/-/g, '');
  db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(id, userId);
  return id;
}

// --- tab-based OAuth handoff ---

// Park a finished (or failed) sign-in under its state, for the extension to collect.
export function savePendingAuth(state, payload) {
  db.prepare('DELETE FROM pending_auth WHERE created_at < datetime(\'now\', \'-10 minutes\')').run();
  db.prepare(
    `INSERT INTO pending_auth (state, session_id, display_name, slack_user_id, error)
     VALUES (@state, @session_id, @display_name, @slack_user_id, @error)
     ON CONFLICT(state) DO UPDATE SET
       session_id = excluded.session_id, display_name = excluded.display_name,
       slack_user_id = excluded.slack_user_id, error = excluded.error`
  ).run({
    state,
    session_id: payload.sessionId || null,
    display_name: payload.displayName || null,
    slack_user_id: payload.slackUserId || null,
    error: payload.error || null,
  });
}

// Read-and-delete: a state is good for exactly one collection.
export function takePendingAuth(state) {
  if (!state) return null;
  const row = db.prepare(
    `SELECT * FROM pending_auth
      WHERE state = ? AND created_at >= datetime('now', '-10 minutes')`
  ).get(state);
  if (row) db.prepare('DELETE FROM pending_auth WHERE state = ?').run(state);
  return row || null;
}

// Resolve the user (incl. their access_token) from a session id.
export function getUserBySession(sessionId) {
  if (!sessionId) return null;
  return db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).get(sessionId);
}

// One daily_log row per user per day: check-in creates it, check-out fills it in.
function findLogId(user_id, date) {
  return db.prepare('SELECT id FROM daily_logs WHERE user_id = ? AND date = ?').get(user_id, date)?.id || null;
}

// Replace a day's items wholesale — the submitted list is always authoritative.
function replaceItems(logId, items) {
  db.prepare('DELETE FROM log_items WHERE daily_log_id = ?').run(logId);
  const ins = db.prepare(
    `INSERT INTO log_items (daily_log_id, text, source, status, "order", depth, is_header)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  items.forEach((it, i) =>
    ins.run(
      logId, it.text, it.source || 'morning',
      it.isHeader ? null : (it.status || 'not_done'),
      i, it.depth || 0, it.isHeader ? 1 : 0
    )
  );
}

// Record the "before you start work" post at check-in. Returns the daily_log id.
export const saveStartLog = db.transaction((payload) => {
  const { user_id, date, slack_channel_id, slack_thread_ts = null, start_post_ts, items = [] } = payload;
  let logId = findLogId(user_id, date);
  if (logId) {
    db.prepare(
      `UPDATE daily_logs SET slack_channel_id = ?, slack_thread_ts = ?, start_post_ts = ? WHERE id = ?`
    ).run(slack_channel_id, slack_thread_ts, start_post_ts, logId);
  } else {
    logId = db.prepare(
      `INSERT INTO daily_logs (user_id, date, slack_channel_id, slack_thread_ts, start_post_ts)
       VALUES (?, ?, ?, ?, ?)`
    ).run(user_id, date, slack_channel_id, slack_thread_ts, start_post_ts).lastInsertRowid;
  }
  replaceItems(logId, items);
  return logId;
});

// A day's stored record plus its items — used to recognise a start-work post we
// made ourselves, without waiting for Slack's search index to catch up.
export function getDayLog(user_id, date) {
  const log = db.prepare('SELECT * FROM daily_logs WHERE user_id = ? AND date = ?').get(user_id, date);
  if (!log) return null;
  const items = db.prepare(
    `SELECT text, status, "order", depth, is_header, source
       FROM log_items WHERE daily_log_id = ? ORDER BY "order"`
  ).all(log.id);
  return { ...log, items: items.map((i) => ({ ...i, isHeader: !!i.is_header })) };
}

// Save a full day's record in one transaction. Returns the daily_log id.
export const saveDailyLog = db.transaction((payload) => {
  const {
    user_id, date, slack_channel_id, slack_thread_ts,
    start_post_ts, finish_post_ts, mood, achievements_text,
    ai_summary = null, ai_sentiment = null, ai_themes = null,
    items = [],
  } = payload;

  const fields = {
    user_id, date, slack_channel_id, slack_thread_ts, start_post_ts,
    finish_post_ts, mood, achievements_text, ai_summary, ai_sentiment,
    ai_themes: ai_themes ? JSON.stringify(ai_themes) : null,
  };

  // Check-in may already have created today's row — update it rather than
  // inserting a second row for the same date.
  let logId = findLogId(user_id, date);
  if (logId) {
    db.prepare(
      `UPDATE daily_logs SET
         slack_channel_id = @slack_channel_id, slack_thread_ts = @slack_thread_ts,
         start_post_ts = COALESCE(@start_post_ts, start_post_ts),
         finish_post_ts = @finish_post_ts, mood = @mood,
         achievements_text = @achievements_text, ai_summary = @ai_summary,
         ai_sentiment = @ai_sentiment, ai_themes = @ai_themes
       WHERE id = @id`
    ).run({ ...fields, id: logId });
  } else {
    logId = db.prepare(
      `INSERT INTO daily_logs
         (user_id, date, slack_channel_id, slack_thread_ts, start_post_ts,
          finish_post_ts, mood, achievements_text, ai_summary, ai_sentiment, ai_themes)
       VALUES (@user_id, @date, @slack_channel_id, @slack_thread_ts, @start_post_ts,
               @finish_post_ts, @mood, @achievements_text, @ai_summary, @ai_sentiment, @ai_themes)`
    ).run(fields).lastInsertRowid;
  }
  replaceItems(logId, items);
  return logId;
});

// Allow running `node src/db.js` to initialize the database.
if (import.meta.url === `file://${process.argv[1]}`) initSchema();
