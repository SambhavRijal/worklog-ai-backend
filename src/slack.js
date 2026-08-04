// slack.js — everything that talks to Slack.
// Each function takes a WebClient built from the CURRENT user's token, so the
// backend can serve many teammates, each posting as themselves.

import { WebClient } from '@slack/web-api';

// Build a client for a specific user token (xoxp-).
export function makeClient(token) {
  return new WebClient(token);
}

// Exchange an OAuth `code` for a user token. Used by the sign-in flow.
// Returns { accessToken, slackUserId }.
export async function exchangeCode({ code, redirectUri }) {
  const anon = new WebClient(); // no token needed for oauth.v2.access
  const r = await anon.oauth.v2.access({
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  const accessToken = r.authed_user?.access_token; // the xoxp user token
  const slackUserId = r.authed_user?.id;
  if (!accessToken) throw new Error('No user access_token returned from Slack');
  return { accessToken, slackUserId };
}

// yyyy-mm-dd for today in the server's local time.
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Epoch seconds at local midnight today — the cutoff for "a previous day".
function startOfTodayEpoch() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// Find the user's most recent post containing `phrase`.
// Results come back newest-first, so skipping anything from today lands on the last
// day actually worked — which handles weekends and holidays without special-casing:
// on Monday this naturally finds Friday's post.
export async function findLastPost(client, phrase, { beforeToday = true } = {}) {
  const res = await client.search.messages({
    query: `from:me "${phrase}"`,
    sort: 'timestamp',
    sort_dir: 'desc', // newest first
    count: 30,
  });

  const cutoff = startOfTodayEpoch();
  for (const m of res?.messages?.matches || []) {
    const ts = Number(m.ts);
    if (!Number.isFinite(ts)) continue;
    if (beforeToday && ts >= cutoff) continue;
    if (!(m.text || '').toLowerCase().includes(phrase.toLowerCase())) continue;
    return {
      channelId: m.channel?.id,
      ts: m.ts,
      text: m.text || '',
      permalink: m.permalink,
      date: new Date(ts * 1000).toISOString().slice(0, 10),
    };
  }
  return null;
}

// Who am I? (attributes the daily_log to the right user)
export async function whoAmI(client) {
  const r = await client.auth.test();
  return { userId: r.user_id, user: r.user, teamId: r.team_id };
}

// Find the current user's "before you start work" message from TODAY, in ANY channel.
export async function findMorningPost(client, marker) {
  const day = todayISO();
  const query = `from:me on:${day} "${marker}"`;

  const res = await client.search.messages({
    query,
    sort: 'timestamp',
    sort_dir: 'asc', // earliest first — the morning post
    count: 20,
  });

  const matches = res?.messages?.matches || [];
  if (!matches.length) return null;

  const m =
    matches.find((x) => (x.text || '').toLowerCase().includes(marker.toLowerCase())) ||
    matches[0];

  // search.messages usually omits thread_ts. If the post is a threaded reply, the real
  // thread anchor is in the permalink's ?thread_ts=… param. Prefer, in order:
  //   explicit thread_ts  ->  permalink thread_ts  ->  the message's own ts (top-level).
  let threadTs = m.thread_ts || threadTsFromPermalink(m.permalink) || m.ts;

  return {
    channelId: m.channel?.id,
    ts: m.ts,
    threadTs,
    text: m.text || '',
    permalink: m.permalink,
  };
}

// Find TODAY's daily-updates thread parent — the message everyone replies under.
//
// The team's flow is: a Slack workflow posts one parent message each morning
// ("Please report in this thread"), listing both markers, and each person replies
// in that thread. So a start-work post must be a REPLY to this message, never a new
// top-level message.
//
// Two ways in, because the parent is posted by a workflow/bot and Slack search does
// not index those reliably:
//
//   1. A TEAMMATE'S REPLY from today — any reply's permalink carries thread_ts, which
//      IS the parent's ts. Replies are ordinary user messages, so they always show up
//      in search. This is the dependable path: by the time you punch in, colleagues
//      have usually posted already.
//   2. The parent itself — top-level (no thread_ts in the permalink) and either
//      matching `anchorPhrase` or mentioning BOTH markers, which replies never do.
//
// No `on:` filter: that resolves against Slack's timezone, so instead we sort newest
// first and cut off at local midnight ourselves.
export async function findTodayThreadAnchor(
  client, { startMarker, finishMarker, anchorPhrase, preferredChannelId = null }
) {
  const since = startOfTodayEpoch();
  const queries = [];
  if (anchorPhrase) queries.push(`"${anchorPhrase}"`);
  queries.push(`"${startMarker}"`);
  if (finishMarker) queries.push(`"${finishMarker}"`);

  let fallback = null; // a usable thread, but not in the channel we'd prefer

  for (const query of queries) {
    let matches = [];
    try {
      const res = await client.search.messages({
        query, sort: 'timestamp', sort_dir: 'desc', count: 50,
      });
      matches = res?.messages?.matches || [];
    } catch {
      continue; // try the next query rather than failing the whole request
    }

    for (const m of matches) {
      const ts = Number(m.ts);
      if (!Number.isFinite(ts) || ts < since) continue; // today only

      const replyThreadTs = threadTsFromPermalink(m.permalink);
      let hit = null;

      if (replyThreadTs) {
        hit = { channelId: m.channel?.id, ts: replyThreadTs, viaReply: true, permalink: m.permalink };
      } else {
        const text = (m.text || '').toLowerCase();
        const isAnchor = anchorPhrase && text.includes(anchorPhrase.toLowerCase());
        const hasBothMarkers =
          text.includes(startMarker.toLowerCase()) && text.includes(finishMarker.toLowerCase());
        if (isAnchor || hasBothMarkers) {
          hit = { channelId: m.channel?.id, ts: m.ts, viaReply: false, permalink: m.permalink };
        }
      }
      if (!hit) continue;
      // Prefer the channel the team actually posts these in, so an unrelated thread
      // that happens to quote the marker can't win.
      if (!preferredChannelId || hit.channelId === preferredChannelId) return hit;
      fallback = fallback || hit;
    }
  }
  if (fallback) return fallback;

  // Last resort — and the ONLY path that works when you're the first to report:
  // with no replies yet, the workflow post is the sole message in the thread, and
  // search indexes those unreliably (and lags for recent messages). Reading channel
  // history sees it immediately. Needs channels:history / groups:history.
  if (preferredChannelId) {
    try {
      const hist = await client.conversations.history({
        channel: preferredChannelId, oldest: String(since), limit: 100,
      });
      for (const m of hist?.messages || []) {
        const text = (m.text || '').toLowerCase();
        const isAnchor = anchorPhrase && text.includes(anchorPhrase.toLowerCase());
        const hasBothMarkers =
          text.includes(startMarker.toLowerCase()) && text.includes(finishMarker.toLowerCase());
        if (isAnchor || hasBothMarkers) {
          // conversations.history returns thread parents, not replies.
          return { channelId: preferredChannelId, ts: m.thread_ts || m.ts, viaHistory: true };
        }
      }
    } catch (e) {
      if (/missing_scope/i.test(e?.message || '')) {
        console.warn(
          'conversations.history needs the channels:history / groups:history user scopes. ' +
          'Add them to the Slack app and sign in again to support being first to report.'
        );
      } else {
        console.warn('conversations.history failed:', e?.message);
      }
    }
  }
  return null;
}

// Find MY earliest message containing `marker` inside a known thread.
// Reads the thread directly, so it sees a post the moment it's made — unlike
// search.messages, whose index lags by minutes. Needs channels:history/groups:history.
export async function findMyReplyInThread(client, { channelId, threadTs, userId, marker }) {
  let messages = [];
  try {
    const res = await client.conversations.replies({ channel: channelId, ts: threadTs, limit: 200 });
    messages = res?.messages || [];
  } catch (e) {
    if (/missing_scope/i.test(e?.message || '')) return null; // not authorised for history
    throw e;
  }

  for (const m of messages) { // oldest first — the morning post
    if (m.user !== userId) continue;
    if (!(m.text || '').toLowerCase().includes(marker.toLowerCase())) continue;
    let permalink = null;
    try {
      permalink = (await client.chat.getPermalink({ channel: channelId, message_ts: m.ts }))?.permalink;
    } catch { /* non-fatal */ }
    return { channelId, ts: m.ts, threadTs, text: m.text || '', permalink };
  }
  return null;
}

// Extract the thread_ts query param from a Slack permalink, if present.
function threadTsFromPermalink(permalink) {
  if (!permalink) return null;
  try {
    return new URL(permalink).searchParams.get('thread_ts');
  } catch {
    return null;
  }
}

// Post a message as the user. With `threadTs` it replies in that thread (the
// "finish work" reply); without it, a new top-level message (the "start work" post).
// `blocks` renders the real bulleted list; `text` is the notification/fallback.
export async function postMessage(client, { channelId, threadTs, text, blocks }) {
  const res = await client.chat.postMessage({
    channel: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
    ...(blocks ? { blocks } : {}),
    unfurl_links: false,
  });
  let permalink = null;
  try {
    const p = await client.chat.getPermalink({ channel: channelId, message_ts: res.ts });
    permalink = p.permalink;
  } catch { /* non-fatal */ }
  return { ts: res.ts, permalink };
}
