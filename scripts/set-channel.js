// set-channel.js — set the Slack channel daily updates are posted to, in the database.
//
//   npm run set-channel -- frontend-daily-collaboration          (everyone without one)
//   npm run set-channel -- frontend-daily-collaboration --all    (everyone, overwriting)
//   npm run set-channel -- frontend-daily-collaboration --user U0123ABCD   (one Slack user)
//
// Posting from WorkLog is set up for the frontend team. Run this once for the people
// already using it; anyone added later sets their own channel in Settings › Modal.
// Uses DATABASE_URL from .env, like the server.
import 'dotenv/config';
import { pool, normChannel } from '../src/db.js';

const args = process.argv.slice(2);
const name = normChannel(args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--user'));
const all = args.includes('--all');
const userIdx = args.indexOf('--user');
const slackUser = userIdx >= 0 ? args[userIdx + 1] : null;

if (!name || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) {
  console.error('Usage: npm run set-channel -- <channel-name> [--all | --user <SlackUserId>]');
  process.exit(1);
}

try {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS post_channel TEXT;
                    ALTER TABLE users ADD COLUMN IF NOT EXISTS post_channel_id TEXT;`);
  const where = slackUser ? 'WHERE slack_user_id = $2'
    : all ? 'WHERE post_channel IS DISTINCT FROM $1'
    : 'WHERE post_channel IS NULL';
  const params = slackUser ? [name, slackUser] : [name];
  // A changed channel forgets the old channel's id; it's learned again from the thread.
  const r = await pool.query(
    `UPDATE users SET post_channel = $1, post_channel_id = NULL ${where}
     RETURNING display_name, slack_user_id`, params);
  console.log(`#${name} set for ${r.rowCount} user${r.rowCount === 1 ? '' : 's'}:`);
  for (const u of r.rows) console.log(`  ${u.display_name || '(no name)'}  ${u.slack_user_id}`);
} catch (e) {
  console.error('Failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
