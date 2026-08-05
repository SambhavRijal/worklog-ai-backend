// server.js — the WorkLog AI backend.
//
// Auth:  each teammate signs in with Slack (per-user OAuth). The extension holds an
//        opaque session id and sends it as `X-Session`. The backend looks up that
//        user's stored token and acts as them. No shared/fallback token exists —
//        an unauthenticated request is rejected, never silently attributed to someone.
//
// Endpoints:
//   GET  /auth/slack/callback  -> Slack redirects here; finishes the OAuth exchange
//   GET  /auth/slack/session   -> extension collects the session for its `state`
//   GET  /day/checkin          -> items still open on the last day worked (carry-over)
//   POST /day/start            -> post the "start work" message + store the record
//   GET  /day/today            -> find my morning post, return parsed items + thread
//   POST /day/post             -> post the "finish work" reply + store the record

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import {
  initSchema, upsertUser, saveUserToken, createSession, getUserBySession,
  saveDailyLog, saveStartLog, getDayLog, savePendingAuth, takePendingAuth,
} from './db.js';
import {
  makeClient, exchangeCode, whoAmI, findMorningPost, findLastPost,
  findTodayThreadAnchor, findMyReplyInThread, postMessage, todayISO,
} from './slack.js';
import {
  parseItems, parseFinishItems, carryOverItems, composeFinishMessage, composeFinishBlocks,
} from './parse.js';

const app = express();
app.use(cors());              // dev-friendly; tighten origins for production
app.use(express.json());

const MARKER = process.env.START_MARKER || 'before you start work';
const FINISH_HEADER = process.env.FINISH_HEADER || 'Before you finish work';
const START_HEADER = process.env.START_HEADER || 'Before you start work';
// Phrase that identifies the daily workflow post everyone replies under.
const THREAD_ANCHOR = process.env.THREAD_ANCHOR || 'Please report in this thread';

// The check-in post has to be findable by the check-out search, which looks for
// START_MARKER. If the header doesn't contain the marker, that loop silently breaks.
if (!START_HEADER.toLowerCase().includes(MARKER.toLowerCase())) {
  console.warn(
    `WARNING: START_HEADER ("${START_HEADER}") does not contain START_MARKER ("${MARKER}").\n` +
    `         Check-out will not find the post that check-in creates.`
  );
}

await initSchema();

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Auth (tab-based OAuth) ---
//
// The extension opens Slack's authorize page in a normal tab and Slack redirects the
// browser here. We finish the exchange, park the session under the random `state`, and
// the extension collects it from /auth/slack/session. Replaces the old
// chrome.identity.launchWebAuthFlow popup, which Chrome renders at a fixed tiny size.
const REDIRECT_URI = `${(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, '')}/auth/slack/callback`;

// A finished-signing-in page. Self-contained; the extension closes the tab anyway.
function authResultPage({ ok, message }) {
  return `<!doctype html><meta charset="utf-8"><title>WorkLog AI</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666}
  @media (prefers-color-scheme:dark){:root{--bg:#181a20;--fg:#e6e8ee;--muted:#98a2b3}}
  body{margin:0;height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
       font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:center}
  .icon{font-size:44px}.msg{margin-top:14px;font-weight:600}.sub{margin-top:6px;color:var(--muted);font-size:13px}
</style>
<div>
  <div class="icon">${ok ? '✅' : '⚠️'}</div>
  <div class="msg">${message}</div>
  <div class="sub">${ok ? 'You can close this tab — WorkLog AI is signed in.' : 'Close this tab and try again from the extension.'}</div>
</div>`;
}

app.get('/auth/slack/callback', async (req, res) => {
  const { code, state, error } = req.query;
  try {
    if (error) {
      if (state) await savePendingAuth(state, { error: `Slack sign-in was cancelled (${error}).` });
      return res.status(400).send(authResultPage({ ok: false, message: 'Sign-in cancelled' }));
    }
    if (!code || !state) {
      return res.status(400).send(authResultPage({ ok: false, message: 'Missing code or state' }));
    }

    const { accessToken, slackUserId } = await exchangeCode({ code, redirectUri: REDIRECT_URI });
    const client = makeClient(accessToken);
    const me = await whoAmI(client);
    const user = await saveUserToken(slackUserId || me.userId, me.user, accessToken);
    const sessionId = await createSession(user.id);

    await savePendingAuth(state, {
      sessionId, displayName: user.display_name, slackUserId: user.slack_user_id,
    });
    res.send(authResultPage({ ok: true, message: `Signed in as ${user.display_name || 'you'}` }));
  } catch (e) {
    console.error(e);
    if (state) await savePendingAuth(state, { error: e.message });
    res.status(500).send(authResultPage({ ok: false, message: 'Sign-in failed' }));
  }
});

// The extension polls this until the callback above has run. One-shot per state.
app.get('/auth/slack/session', async (req, res) => {
  const row = await takePendingAuth(req.query.state);
  if (!row) return res.status(204).end();          // not finished yet
  if (row.error) return res.status(400).json({ error: row.error });
  res.json({
    sessionId: row.session_id,
    displayName: row.display_name,
    slackUserId: row.slack_user_id,
  });
});

// Resolve the acting user + a Slack client for this request, strictly from the
// signed-in session. There is no fallback token: no session -> no client.
async function resolveClient(req) {
  const session = req.get('X-Session');
  const user = await getUserBySession(session);
  if (user?.access_token) return { client: makeClient(user.access_token), user };
  return { client: null, user: null };
}

async function requireAuth(req, res) {
  const ctx = await resolveClient(req);
  if (!ctx.client) {
    res.status(401).json({ error: 'Not signed in. Sign in with Slack.' });
    return null;
  }
  return ctx;
}

// --- Find today's morning post (any channel) + parsed checklist items ---
app.get('/day/today', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const me = await whoAmI(auth.client);
    let post = await findMorningPost(auth.client, MARKER);

    // Slack's search index lags a few minutes, so a start-work post made moments ago
    // is invisible to it. Two search-free fallbacks before giving up:
    if (!post) {
      // 1. We posted it ourselves — the record (and its items) are already local.
      const user = auth.user || await upsertUser(me.userId, me.user);
      const local = await getDayLog(user.id, todayISO());
      if (local?.start_post_ts && local.slack_thread_ts) {
        return res.json({
          found: true,
          slackUserId: me.userId,
          channelId: local.slack_channel_id,
          threadTs: local.slack_thread_ts,
          startPostTs: local.start_post_ts,
          permalink: null,
          rawText: null,
          items: local.items.map((it, i) => ({
            text: it.text,
            depth: it.depth || 0,
            isHeader: it.isHeader,
            status: it.isHeader ? null : 'done',
            source: 'morning',
            order: i,
          })),
        });
      }

      // 2. Posted manually in Slack — read today's thread directly.
      const anchor = await findTodayThreadAnchor(auth.client, {
        startMarker: MARKER, finishMarker: FINISH_HEADER, anchorPhrase: THREAD_ANCHOR,
        preferredChannelId: local?.slack_channel_id || null,
      });
      if (anchor) {
        post = await findMyReplyInThread(auth.client, {
          channelId: anchor.channelId, threadTs: anchor.ts, userId: me.userId, marker: MARKER,
        });
      }
    }

    if (!post) {
      return res.json({ found: false, marker: MARKER, slackUserId: me.userId, items: [] });
    }

    const parsed = await parseItems(post.text, MARKER);
    res.json({
      found: true,
      slackUserId: me.userId,
      channelId: post.channelId,
      threadTs: post.threadTs,
      startPostTs: post.ts,
      permalink: post.permalink,
      rawText: post.text,
      // Leaf tasks default to "done" (most days everything's finished → single-click post).
      // Headers (category labels with children) get no status — they aren't tickable.
      items: parsed.map((it, i) => ({
        text: it.text,
        depth: it.depth,
        isHeader: it.isHeader,
        status: it.isHeader ? null : 'done',
        source: 'morning',
        order: i,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Check-in: carry forward whatever was still open on the last day worked ---
app.get('/day/checkin', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const last = await findLastPost(auth.client, FINISH_HEADER);

    // Today's post belongs INSIDE the daily-updates thread, so the anchor decides
    // both the channel and the thread to reply under.
    const anchor = await findTodayThreadAnchor(auth.client, {
      startMarker: MARKER,
      finishMarker: FINISH_HEADER,
      anchorPhrase: THREAD_ANCHOR,
      preferredChannelId: last?.channelId || null, // where these normally get posted
    });

    const carried = last ? carryOverItems(parseFinishItems(last.text)) : [];
    res.json({
      found: !!last,
      header: START_HEADER,
      channelId: anchor?.channelId || null,
      threadTs: anchor?.ts || null,
      threadPermalink: anchor?.permalink || null,
      sourceDate: last?.date || null,
      permalink: last?.permalink || null,
      items: carried.map((it, i) => ({
        text: it.text,
        depth: it.depth,
        isHeader: it.isHeader,
        status: null,            // a plan has no status icons
        source: 'carried_over',
        order: i,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Post the reviewed "start work" message (new top-level message) ---
app.post('/day/start', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const { channelId, threadTs, items = [] } = req.body;
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    if (!items.length) return res.status(400).json({ error: 'Nothing to post — add at least one item.' });
    // Refuse rather than post top-level: a stray message in the channel instead of
    // a thread reply is worse than not posting at all.
    if (!threadTs) {
      return res.status(400).json({
        error: "Couldn't find today's daily-updates thread, so there's nowhere to reply. " +
               'Post in Slack manually this once.',
      });
    }

    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);

    const plan = items.map((it) => ({ ...it, status: null })); // plans post without icons
    const text = composeFinishMessage({ header: START_HEADER, items: plan, achievements: '' });
    const blocks = composeFinishBlocks({ header: START_HEADER, items: plan, achievements: '' });
    const posted = await postMessage(auth.client, { channelId, threadTs, text, blocks });

    const logId = await saveStartLog({
      user_id: user.id,
      date: todayISO(),
      slack_channel_id: channelId,
      slack_thread_ts: threadTs,
      start_post_ts: posted.ts,
      items: plan,
    });

    res.json({ ok: true, dailyLogId: logId, slackPermalink: posted.permalink });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Post the reviewed "finish work" message + store the record ---
app.post('/day/post', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const {
      channelId, threadTs, startPostTs, items = [], mood = null,
      achievements = '', postAchievements = false,
    } = req.body;
    if (!channelId || !threadTs) return res.status(400).json({ error: 'channelId and threadTs are required' });

    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);

    // Achievements post only when the user toggled it on. Mood is never posted.
    // Either way, both are stored in the DB below.
    const ach = postAchievements ? achievements : '';
    const text = composeFinishMessage({ header: FINISH_HEADER, items, achievements: ach });
    const blocks = composeFinishBlocks({ header: FINISH_HEADER, items, achievements: ach });
    const posted = await postMessage(auth.client, { channelId, threadTs, text, blocks });

    const logId = await saveDailyLog({
      user_id: user.id,
      date: todayISO(),
      slack_channel_id: channelId,
      slack_thread_ts: threadTs,
      start_post_ts: startPostTs || null,
      finish_post_ts: posted.ts,
      mood,
      achievements_text: achievements,
      items,
    });

    res.json({ ok: true, dailyLogId: logId, slackPermalink: posted.permalink });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// On a serverless host (Vercel) the platform imports this module and drives the
// exported handler itself — calling listen() there binds a port nothing routes to.
// Locally we still want a real server, so only listen when not on Vercel.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 8787;
  app.listen(PORT, () => console.log(`WorkLog AI backend on http://localhost:${PORT}`));
}

export default app;
