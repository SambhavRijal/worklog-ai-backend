// debug-thread.js — show exactly what Slack search returns for today's thread lookup.
//
// Run it when check-in says "daily-updates thread not found":
//   cd backend && node scripts/debug-thread.js
//
// It uses the token already stored for your signed-in user, runs the same queries
// findTodayThreadAnchor uses, and prints what came back — so we can see whether the
// workflow post is indexed, whether teammates' replies are visible, and which
// message (if any) the thread would be taken from. Read-only: posts nothing.

import 'dotenv/config';
import { pool } from '../src/db.js';
import { makeClient, findTodayThreadAnchor } from '../src/slack.js';

const MARKER = process.env.START_MARKER || 'before you start work';
const FINISH_HEADER = process.env.FINISH_HEADER || 'Before you finish work';
const THREAD_ANCHOR = process.env.THREAD_ANCHOR || 'Please report in this thread';

const user = (await pool.query(
  'SELECT * FROM users WHERE access_token IS NOT NULL ORDER BY id DESC LIMIT 1'
)).rows[0];

if (!user) {
  console.error('No signed-in user found. Sign in through the extension first.');
  process.exit(1);
}
console.log(`Using stored token for: ${user.display_name} (${user.slack_user_id})\n`);

const client = makeClient(user.access_token);
const startOfToday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d / 1000); })();
console.log(`Local midnight cutoff: ${new Date(startOfToday * 1000).toString()}\n`);

const threadTsFromPermalink = (p) => {
  try { return new URL(p).searchParams.get('thread_ts'); } catch { return null; }
};

for (const query of [`"${THREAD_ANCHOR}"`, `"${MARKER}"`, `"${FINISH_HEADER}"`]) {
  console.log(`\n=== query: ${query} ===`);
  try {
    const res = await client.search.messages({ query, sort: 'timestamp', sort_dir: 'desc', count: 20 });
    const matches = res?.messages?.matches || [];
    console.log(`total matches: ${matches.length}`);
    for (const m of matches.slice(0, 10)) {
      const ts = Number(m.ts);
      const today = ts >= startOfToday;
      const thread = threadTsFromPermalink(m.permalink);
      console.log(
        `  ${today ? 'TODAY  ' : 'older  '} ` +
        `ch=${m.channel?.id}(${m.channel?.name || '?'}) ` +
        `from=${m.username || m.user || '?'} ` +
        `${thread ? `REPLY thread_ts=${thread}` : 'TOP-LEVEL'} ` +
        `| ${(m.text || '').replace(/\s+/g, ' ').slice(0, 70)}`
      );
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

// Which channel do these normally go to? (from the last finish post)
const { findLastPost } = await import('../src/slack.js');
const last = await findLastPost(client, FINISH_HEADER);
const channelId = last?.channelId || null;
console.log(`\n=== channel from last finish post: ${channelId || 'none found'} ===`);

if (channelId) {
  console.log('\n=== conversations.history (the first-to-report path) ===');
  try {
    const hist = await client.conversations.history({
      channel: channelId, oldest: String(startOfToday), limit: 50,
    });
    const msgs = hist?.messages || [];
    console.log(`messages in that channel since local midnight: ${msgs.length}`);
    for (const m of msgs.slice(0, 10)) {
      console.log(
        `  ts=${m.ts} ${m.bot_id ? 'BOT' : 'user'} ` +
        `replies=${m.reply_count || 0} | ${(m.text || '').replace(/\s+/g, ' ').slice(0, 70)}`
      );
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    if (/missing_scope/i.test(e.message)) {
      console.log('  -> Add channels:history + groups:history to the Slack app, then sign in again.');
    }
  }
}

console.log('\n=== what findTodayThreadAnchor resolves to ===');
const anchor = await findTodayThreadAnchor(client, {
  startMarker: MARKER, finishMarker: FINISH_HEADER, anchorPhrase: THREAD_ANCHOR,
  preferredChannelId: channelId,
});
console.log(anchor ? anchor : 'null — no thread found, check-in would refuse to post');

await pool.end();
