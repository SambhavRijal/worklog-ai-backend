// migrate-sqlite-to-postgres.js — one-time copy of the old SQLite data into Postgres.
//
// Carries over users (including their Slack access tokens, so nobody has to sign in
// again), sessions, daily logs and items. Skips pending_auth: those expire in minutes.
//
//   node scripts/migrate-sqlite-to-postgres.js <path-to-worklog.db>
//
// Safe to re-run: every insert is an upsert keyed on natural keys, so a second run
// updates rather than duplicating. Reads the SQLite file; never writes to it.
//
// better-sqlite3 is no longer a dependency, so install it just for this:
//   npm i -D better-sqlite3

import 'dotenv/config';
import { pool, initSchema } from '../src/db.js';

const sqlitePath = process.argv[2];
if (!sqlitePath) {
  console.error('Usage: node scripts/migrate-sqlite-to-postgres.js <path-to-worklog.db>');
  process.exit(1);
}

let Database;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch {
  console.error('better-sqlite3 is not installed. Run:  npm i -D better-sqlite3');
  process.exit(1);
}

const sqlite = new Database(sqlitePath, { readonly: true });
await initSchema();

const client = await pool.connect();
try {
  await client.query('BEGIN');

  // --- users: remap old integer ids to whatever Postgres assigns ---
  const users = sqlite.prepare('SELECT * FROM users').all();
  const userIdMap = new Map();
  for (const u of users) {
    const { rows } = await client.query(
      `INSERT INTO users (slack_user_id, display_name, access_token) VALUES ($1, $2, $3)
       ON CONFLICT (slack_user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, access_token = EXCLUDED.access_token
       RETURNING id`,
      [u.slack_user_id, u.display_name, u.access_token]
    );
    userIdMap.set(u.id, rows[0].id);
  }

  // --- sessions: keeps everyone signed in ---
  let sessions = 0;
  for (const s of sqlite.prepare('SELECT * FROM sessions').all()) {
    const newUserId = userIdMap.get(s.user_id);
    if (!newUserId) continue;
    await client.query(
      `INSERT INTO sessions (id, user_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [s.id, newUserId]
    );
    sessions++;
  }

  // --- daily logs + their items ---
  let logs = 0, items = 0;
  for (const d of sqlite.prepare('SELECT * FROM daily_logs ORDER BY id').all()) {
    const newUserId = userIdMap.get(d.user_id);
    if (!newUserId) continue;
    let themes = null;
    if (d.ai_themes) { try { themes = JSON.stringify(JSON.parse(d.ai_themes)); } catch { themes = null; } }

    const { rows } = await client.query(
      `INSERT INTO daily_logs
         (user_id, date, slack_channel_id, slack_thread_ts, start_post_ts,
          finish_post_ts, mood, achievements_text, ai_summary, ai_sentiment, ai_themes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (user_id, date) DO UPDATE SET
         slack_channel_id = EXCLUDED.slack_channel_id,
         slack_thread_ts  = EXCLUDED.slack_thread_ts,
         start_post_ts    = COALESCE(EXCLUDED.start_post_ts, daily_logs.start_post_ts),
         finish_post_ts   = COALESCE(EXCLUDED.finish_post_ts, daily_logs.finish_post_ts)
       RETURNING id`,
      [newUserId, d.date, d.slack_channel_id, d.slack_thread_ts, d.start_post_ts,
       d.finish_post_ts, d.mood, d.achievements_text, d.ai_summary, d.ai_sentiment, themes]
    );
    const logId = rows[0].id;
    logs++;

    // The old schema allowed duplicate rows per date; replace items so a re-run
    // (or a duplicate source row) can't stack them up.
    await client.query('DELETE FROM log_items WHERE daily_log_id = $1', [logId]);
    const oldItems = sqlite
      .prepare('SELECT * FROM log_items WHERE daily_log_id = ? ORDER BY "order"')
      .all(d.id);
    for (const [i, it] of oldItems.entries()) {
      await client.query(
        `INSERT INTO log_items (daily_log_id, text, source, status, "order", depth, is_header, ai_category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [logId, it.text, it.source, it.status, i, it.depth || 0, !!it.is_header, it.ai_category || null]
      );
      items++;
    }
  }

  await client.query('COMMIT');
  console.log(`migrated: ${users.length} users, ${sessions} sessions, ${logs} daily logs, ${items} items`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('migration failed, nothing was written:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  sqlite.close();
  await pool.end();
}
