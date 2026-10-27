// server.js — the WorkLog AI backend.
//
// Auth:  each teammate signs in with Slack (per-user OAuth). The extension holds an
//        opaque session id and sends it as `X-Session`. The backend looks up that
//        user's stored token and acts as them. No shared/fallback token exists —
//        an unauthenticated request is rejected, never silently attributed to someone.
//
// Endpoints:
//   GET  /privacy, /terms      -> public policy pages (Atlassian requires these)
//   GET  /auth/slack/callback  -> Slack redirects here; finishes the OAuth exchange
//   GET  /auth/slack/session   -> extension collects the session for its `state`
//   POST /auth/jira/start      -> begin the Jira OAuth round trip (returns authUrl)
//   GET  /auth/jira/callback   -> Atlassian redirects here; stores the connection
//   GET  /auth/jira/session    -> extension polls for the result of its `state`
//   GET  /jira/status          -> is Jira linked for me?
//   POST /jira/disconnect      -> unlink Jira
//   GET  /jira/today           -> my sprint sub-tasks (?mode=checkin|checkout)
//   GET  /jira/sites           -> which Jira sites this account granted us
//   POST /jira/site            -> switch which granted site we query
//   GET  /jira/probe           -> diagnose an empty panel (names + per-clause counts)
//   GET  /day/checkin          -> items still open on the last day worked (carry-over)
//   POST /day/start            -> post the "start work" message + store the record
//   GET  /day/today            -> find my morning post, return parsed items + thread
//   POST /day/post             -> post the "finish work" reply + store the record
//   POST /me/delete            -> erase everything stored for the caller

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';

import {
  pool, upsertUser, saveUserToken, createSession, getUserBySession,
  saveDailyLog, saveStartLog, getDayLog, savePendingAuth, takePendingAuth,
  saveJiraConnection, getJiraConnection, deleteJiraConnection, updateJiraTokens,
  setJiraStoryPointsField, setJiraIssueTypes, createJiraAuthState, getJiraAuthState,
  finishJiraAuthState, takeJiraAuthResult, deleteUserData,
} from './db.js';
import {
  makeClient, exchangeCode, whoAmI, findMorningPost, findLastPost,
  findTodayThreadAnchor, findMyReplyInThread, postMessage, todayISO,
} from './slack.js';
import {
  parseItems, parseFinishItems, carryOverItems, composeFinishMessage, composeFinishBlocks,
} from './parse.js';
import {
  jiraConfigured, jiraAuthUrl, exchangeJiraCode, accessibleResources,
  jiraMyself, findStoryPointsField, findSubtaskIssueTypes, monthWeight, listIssueTypes, issuesForMode,
  buildJql, statusesFor, countFor, sampleMine, runJql,
} from './jira.js';

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

// Schema creation is a deploy step (`npm run init-db`), not something the server does
// at boot. Doing it here ran DDL on every serverless cold start, and — worse — a
// top-level await that rejects stops the module loading at all, so an unreachable
// database took down every route including /health.

// Deliberately dependency-free so it answers even when the database is down; `db`
// tells you whether that's the problem.
app.get('/health', async (_req, res) => {
  const out = { ok: true };
  try {
    await pool.query('SELECT 1');
    out.db = 'connected';
  } catch (e) {
    out.db = 'error';
    out.dbError = e.message;
  }
  res.json(out);
});

// --- Public policy pages ---
//
// Atlassian requires a privacy policy URL before an OAuth app can be shared beyond its
// owner. Served from here because this backend is already deployed on a domain you
// control — no extra hosting, and the URL never goes stale.
//
// The contents describe what this app ACTUALLY does. Set VENDOR_NAME and
// PRIVACY_CONTACT_EMAIL; review the wording before pointing Atlassian at it.
const VENDOR_NAME = process.env.VENDOR_NAME || 'the WorkLog AI operator';
const PRIVACY_CONTACT = process.env.PRIVACY_CONTACT_EMAIL || 'SET_PRIVACY_CONTACT_EMAIL';

function policyPage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — WorkLog AI</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#16181d;--muted:#5b6472;--line:#e5e7eb}
  @media (prefers-color-scheme:dark){:root{--bg:#14161b;--fg:#e6e8ee;--muted:#98a2b3;--line:#2a2e38}}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif}
  main{max-width:720px;margin:0 auto;padding:48px 22px 80px}
  h1{font-size:26px;margin:0 0 6px}
  h2{font-size:17px;margin:32px 0 8px}
  .updated{color:var(--muted);font-size:13px;margin-bottom:28px}
  ul{padding-left:20px}li{margin:5px 0}
  code{background:rgba(127,127,127,.14);padding:1px 5px;border-radius:4px;font-size:14px}
  hr{border:none;border-top:1px solid var(--line);margin:34px 0}
  a{color:inherit}
</style></head><body><main>${bodyHtml}</main></body></html>`;
}

app.get('/privacy', (_req, res) => {
  res.type('html').send(policyPage('Privacy Policy', `
  <h1>WorkLog AI — Privacy Policy</h1>
  <div class="updated">Operated by ${VENDOR_NAME}. Last updated ${new Date().toISOString().slice(0, 10)}.</div>

  <p>WorkLog AI is an internal tool that turns a person's daily Slack stand-up update into
  a guided form, and optionally shows their Jira issues alongside it. It is used by
  members of the operator's organisation. This page describes exactly what it stores.</p>

  <h2>What is stored</h2>
  <ul>
    <li><b>Slack access token</b> issued to you when you sign in, plus your Slack user id and display name.</li>
    <li><b>Jira access and refresh tokens</b> if you choose to connect Jira, plus your Atlassian account id, display name, and which Jira site you connected.</li>
    <li><b>Your daily log</b>: the items in your start-work and finish-work posts, their status, an optional 1–5 mood rating, and optional achievements text.</li>
    <li><b>References to your Slack messages</b>: channel id, thread and message timestamps — not a copy of your conversations.</li>
  </ul>

  <h2>What it does with them</h2>
  <ul>
    <li>Reads your own Slack messages to find your stand-up thread, and posts your update <b>as you</b>.</li>
    <li>Reads your assigned Jira issues. The Jira permissions requested are <b>read-only</b>
        (<code>read:jira-work</code>, <code>read:jira-user</code>) — it cannot modify anything in Jira.</li>
    <li>Stores your daily log so it can carry unfinished items into the next day.</li>
  </ul>

  <h2>Where it is stored, and who sees it</h2>
  <p>In a Postgres database operated by ${VENDOR_NAME}. Data is not sold, and is not shared
  with third parties. The only external services contacted are Slack and Atlassian, on
  your behalf, using your own tokens.</p>

  <h2>Retention and removal</h2>
  <ul>
    <li><b>Disconnecting Jira</b> in the extension's settings deletes your Jira tokens immediately.</li>
    <li><b>Delete my data</b>, in the extension's settings, erases everything listed above
        — tokens, sessions and your whole daily-log history — and revokes the Slack token.
        This is immediate and cannot be undone.</li>
    <li><b>Signing out</b> only removes the session from your browser; it does not delete
        server-side data. Use <b>Delete my data</b> for that.</li>
    <li>You can also revoke access at any time from Slack and from your Atlassian account settings.</li>
  </ul>

  <h2>Contact</h2>
  <p>${PRIVACY_CONTACT}</p>
  <hr>
  <p class="updated">See also the <a href="/terms">terms of use</a>.</p>`));
});

app.get('/terms', (_req, res) => {
  res.type('html').send(policyPage('Terms of Use', `
  <h1>WorkLog AI — Terms of Use</h1>
  <div class="updated">Operated by ${VENDOR_NAME}. Last updated ${new Date().toISOString().slice(0, 10)}.</div>

  <p>WorkLog AI is an internal tool provided by ${VENDOR_NAME} to members of its
  organisation, at no charge and without warranty.</p>

  <h2>Use</h2>
  <ul>
    <li>Sign in with your own Slack and Atlassian accounts. Posts are made as you, so you
        are responsible for what you publish through it.</li>
    <li>Access to the tool follows access to the underlying Slack workspace and Jira site.</li>
  </ul>

  <h2>Availability</h2>
  <p>The service may change or stop at any time. It depends on Slack and Atlassian, and
  will not work when those are unavailable.</p>

  <h2>Liability</h2>
  <p>Provided "as is". ${VENDOR_NAME} is not liable for lost or incorrect updates, or for
  anything arising from use of the tool, to the extent permitted by law.</p>

  <h2>Contact</h2>
  <p>${PRIVACY_CONTACT}</p>
  <hr>
  <p class="updated">See also the <a href="/privacy">privacy policy</a>.</p>`));
});

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
  try {
    const row = await takePendingAuth(req.query.state);
    if (!row) return res.status(204).end();          // not finished yet
    if (row.error) return res.status(400).json({ error: row.error });
    res.json({
      sessionId: row.session_id,
      displayName: row.display_name,
      slackUserId: row.slack_user_id,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// --- Jira (Atlassian OAuth 3LO) ---
//
// The callback arrives straight from Atlassian with none of our headers, so the random
// `state` — registered against the caller's session before the tab opens — is what ties
// the round trip back to a user.
const JIRA_REDIRECT_URI = `${(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, '')}/auth/jira/callback`;

// Begin the flow: returns the URL for the extension to open in a tab.
app.post('/auth/jira/start', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    if (!jiraConfigured()) {
      return res.status(503).json({ error: 'Jira is not configured on this server (JIRA_CLIENT_ID / JIRA_CLIENT_SECRET).' });
    }
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);
    const state = 'jira_' + randomUUID().replace(/-/g, '');
    await createJiraAuthState(state, user.id);
    res.json({ state, authUrl: jiraAuthUrl({ redirectUri: JIRA_REDIRECT_URI, state }) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/jira/callback', async (req, res) => {
  const { code, state, error, error_description: errDesc } = req.query;
  try {
    if (error) {
      if (state) await finishJiraAuthState(state, errDesc || `Jira authorisation was cancelled (${error}).`);
      return res.status(400).send(authResultPage({ ok: false, message: 'Jira connection cancelled' }));
    }
    if (!code || !state) {
      return res.status(400).send(authResultPage({ ok: false, message: 'Missing code or state' }));
    }
    const pending = await getJiraAuthState(state);
    if (!pending) {
      return res.status(400).send(authResultPage({ ok: false, message: 'This link has expired — try again' }));
    }

    const tok = await exchangeJiraCode({ code, redirectUri: JIRA_REDIRECT_URI });
    const sites = await accessibleResources(tok.access_token);
    if (!sites?.length) throw new Error('No Jira sites were granted to this app.');
    // An Atlassian account can have SEVERAL sites (jobinsv1, jobinsv2 …). Taking the
    // first silently queries the wrong Jira: valid JQL, correct token, zero results.
    // JIRA_SITE picks by name or URL substring; otherwise fall back to the first.
    const want = (process.env.JIRA_SITE || '').trim().toLowerCase();
    const site = (want && sites.find((s) =>
      (s.name || '').toLowerCase().includes(want) || (s.url || '').toLowerCase().includes(want)
    )) || sites[0];
    if (sites.length > 1 && !want) {
      console.warn(`Multiple Jira sites granted (${sites.map((s) => s.name).join(', ')}); ` +
                   `defaulting to "${site.name}". Set JIRA_SITE to choose.`);
    }

    const conn = {
      cloudId: site.id,
      siteUrl: site.url,
      siteName: site.name,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    };

    // Best-effort enrichment — a failure here shouldn't lose the connection.
    const provisional = { ...conn, cloud_id: conn.cloudId, access_token: conn.accessToken };
    try {
      const me = await jiraMyself(provisional);
      conn.accountId = me.accountId;
      conn.displayName = me.displayName;
    } catch { /* non-fatal */ }
    try { conn.storyPointsField = await findStoryPointsField(provisional); } catch { /* non-fatal */ }

    await saveJiraConnection(pending.user_id, conn);
    await finishJiraAuthState(state, null);
    res.send(authResultPage({ ok: true, message: `Jira connected — ${site.name}` }));
  } catch (e) {
    console.error(e);
    if (state) await finishJiraAuthState(state, e.message);
    res.status(500).send(authResultPage({ ok: false, message: 'Jira connection failed' }));
  }
});

// Polled by the extension while the tab is open.
app.get('/auth/jira/session', async (req, res) => {
  try {
    const row = await takeJiraAuthResult(req.query.state);
    if (!row) return res.status(204).end();
    if (row.error) return res.status(400).json({ error: row.error });
    const conn = await getJiraConnection(row.user_id);
    res.json({ connected: true, siteName: conn?.site_name, siteUrl: conn?.site_url, displayName: conn?.display_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Is Jira linked for the caller?
app.get('/jira/status', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);
    const conn = await getJiraConnection(user.id);
    res.json({
      configured: jiraConfigured(),
      connected: !!conn,
      siteName: conn?.site_name || null,
      siteUrl: conn?.site_url || null,
      displayName: conn?.display_name || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/jira/disconnect', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);
    await deleteJiraConnection(user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Sprint sub-tasks assigned to me. ?mode=checkin returns what's still ahead;
// ?mode=checkout returns what moved. Defaults to checkout.
app.get('/jira/today', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);
    const conn = await getJiraConnection(user.id);
    if (!conn) return res.json({ connected: false, issues: [] });

    const onTokens = (t) => updateJiraTokens(user.id, t);

    // Older connections predate story-point discovery; fill it in once.
    let spField = conn.story_points_field;
    if (!spField) {
      try {
        spField = await findStoryPointsField(conn, { onTokens });
        if (spField) await setJiraStoryPointsField(user.id, spField);
      } catch { /* non-fatal */ }
    }

    // Which issue types count as sub-task-ish here. Discovered once per connection
    // because subTaskIssueTypes() misses types that merely LOOK like sub-tasks.
    let issueTypes = (conn.issue_types || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!issueTypes.length) {
      try {
        issueTypes = await findSubtaskIssueTypes(conn, { onTokens });
        if (issueTypes.length) await setJiraIssueTypes(user.id, issueTypes);
      } catch { /* fall back to subTaskIssueTypes() in the JQL */ }
    }

    const mode = req.query.mode === 'checkin' ? 'checkin' : 'checkout';
    const issues = await issuesForMode(conn, { mode, storyPointsField: spField, issueTypes, onTokens });
    res.json({ connected: true, siteName: conn.site_name, mode, issueTypes, issues });
  } catch (e) {
    if (e.message === 'JIRA_UNAUTHORISED') {
      return res.status(409).json({ error: 'Jira access expired — reconnect Jira in Settings.' });
    }
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// This month's task weight: story points on my issues whose "Task Weight Counted As"
// falls in the current month. Independent of sprint and of the page the modal is on.
// ?tz=<minutes east of UTC> picks which calendar month "this month" is.
app.get('/jira/month', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);
    const conn = await getJiraConnection(user.id);
    if (!conn) return res.json({ connected: false });

    const onTokens = (t) => updateJiraTokens(user.id, t);
    let spField = conn.story_points_field;
    if (!spField) {
      try {
        spField = await findStoryPointsField(conn, { onTokens });
        if (spField) await setJiraStoryPointsField(user.id, spField);
      } catch { /* non-fatal */ }
    }
    const tz = Number(req.query.tz);
    const out = await monthWeight(conn, {
      storyPointsField: spField, onTokens, tzOffsetMin: Number.isFinite(tz) ? tz : 0,
    });
    if (out.storyPointsFieldUsed && out.storyPointsFieldUsed !== spField) {
      try { await setJiraStoryPointsField(user.id, out.storyPointsFieldUsed); } catch { /* non-fatal */ }
    }
    res.json({ connected: true, ...out });
  } catch (e) {
    if (e.message === 'JIRA_UNAUTHORISED') {
      return res.status(409).json({ error: 'Jira access expired — reconnect Jira in Settings.' });
    }
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Which Jira sites did this user grant us?
app.get('/jira/sites', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);
    const conn = await getJiraConnection(user.id);
    if (!conn) return res.json({ connected: false, sites: [] });
    const sites = await accessibleResources(conn.access_token);
    res.json({
      connected: true,
      current: { cloudId: conn.cloud_id, name: conn.site_name, url: conn.site_url },
      sites: (sites || []).map((s) => ({ cloudId: s.id, name: s.name, url: s.url })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Switch which granted site we query, without redoing the OAuth dance.
app.post('/jira/site', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const { cloudId } = req.body || {};
    if (!cloudId) return res.status(400).json({ error: 'cloudId is required' });
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);
    const conn = await getJiraConnection(user.id);
    if (!conn) return res.status(400).json({ error: 'Jira is not connected.' });

    const sites = await accessibleResources(conn.access_token);
    const site = (sites || []).find((s) => s.id === cloudId);
    if (!site) return res.status(400).json({ error: 'That site was not granted to this app.' });

    await saveJiraConnection(user.id, {
      cloudId: site.id, siteUrl: site.url, siteName: site.name,
      accountId: conn.account_id, displayName: conn.display_name,
      accessToken: conn.access_token, refreshToken: conn.refresh_token,
      expiresAt: conn.expires_at,
      storyPointsField: null,   // these are per-site; rediscover for the new one
    });
    await setJiraIssueTypes(user.id, []);
    await setJiraStoryPointsField(user.id, null);
    res.json({ ok: true, siteName: site.name, siteUrl: site.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Diagnose an empty panel: reports what this site actually calls things, and how many
// issues each clause of the query matches. Read-only; nothing is written to Jira.
app.get('/jira/probe', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);
    const conn = await getJiraConnection(user.id);
    if (!conn) return res.json({ connected: false });
    const onTokens = (t) => updateJiraTokens(user.id, t);
    const opts = { onTokens };

    // ?jql=... runs exactly that query and returns nothing else, so a failing
    // clause can be bisected without a redeploy per attempt.
    if (req.query.jql) {
      return res.json({ jql: req.query.jql, ...(await runJql(conn, String(req.query.jql), opts)) });
    }

    const out = { connected: true, site: conn.site_name, siteUrl: conn.site_url, cloudId: conn.cloud_id };
    try {
      out.grantedSites = (await accessibleResources(conn.access_token))
        .map((s) => ({ cloudId: s.id, name: s.name, url: s.url, current: s.id === conn.cloud_id }));
    } catch (e) { out.grantedSites = 'error: ' + e.message; }
    try { out.jiraUser = (await jiraMyself(conn, opts))?.displayName; } catch (e) { out.jiraUser = 'error: ' + e.message; }
    try {
      out.allIssueTypes = await listIssueTypes(conn, opts);
    } catch (e) { out.allIssueTypes = 'error: ' + e.message; }
    try { out.discoveredSubtaskTypes = await findSubtaskIssueTypes(conn, opts); }
    catch (e) { out.discoveredSubtaskTypes = 'error: ' + e.message; }
    out.cachedIssueTypes = conn.issue_types || null;
    out.checkinStatuses = statusesFor('checkin');
    out.checkoutStatuses = statusesFor('checkout');

    const it = (out.discoveredSubtaskTypes instanceof Array) ? out.discoveredSubtaskTypes : null;
    // Narrow one clause at a time so the first zero tells you which clause is wrong.
    out.counts = {
      'assignee only': await countFor(conn, 'assignee = currentUser()', opts),
      'assignee + openSprints': await countFor(conn, 'assignee = currentUser() AND sprint IN openSprints()', opts),
      'assignee + subTaskIssueTypes()': await countFor(conn, 'assignee = currentUser() AND issuetype IN subTaskIssueTypes()', opts),
      'assignee + discovered types': it?.length
        ? await countFor(conn, `assignee = currentUser() AND issuetype IN (${it.map((n) => JSON.stringify(n)).join(', ')})`, opts)
        : 'n/a',
      'assignee + changed today': await countFor(conn, 'assignee = currentUser() AND status CHANGED AFTER startOfDay()', opts),
      'assignee + status To Do': await countFor(conn, 'assignee = currentUser() AND status = "To Do"', opts),
      'assignee + status IN checkin': await countFor(conn, `assignee = currentUser() AND status IN (${statusesFor('checkin').map((n) => JSON.stringify(n)).join(', ')})`, opts),
      'assignee + sprint + types': it?.length
        ? await countFor(conn, `assignee = currentUser() AND sprint IN openSprints() AND issuetype IN (${it.map((n) => JSON.stringify(n)).join(', ')})`, opts)
        : 'n/a',
      'full checkin jql': await countFor(conn, buildJql('checkin', { issueTypes: it }), opts),
      'full checkout jql': await countFor(conn, buildJql('checkout', { issueTypes: it }), opts),
    };
    out.jql = {
      checkin: buildJql('checkin', { issueTypes: it }),
      checkout: buildJql('checkout', { issueTypes: it }),
    };
    // The decisive bit: what your issues are ACTUALLY called.
    out.sample = await sampleMine(conn, opts);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Delete everything this backend holds for the caller. Irreversible by design — the
// privacy policy promises it, so it has to actually do it rather than just log out.
app.post('/me/delete', async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const me = await whoAmI(auth.client);
    const user = auth.user || await upsertUser(me.userId, me.user);

    // Best effort: hand the Slack token back before dropping it, so it stops working
    // even if a copy leaked. A failure here must not block the deletion.
    try { await auth.client.auth.revoke(); } catch { /* revoking is a courtesy */ }

    const removed = await deleteUserData(user.id);
    res.json({ ok: true, removed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
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

// Anything unmatched should say so, not hang.
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Backstop. Express 4 does NOT forward rejected async handlers here — that's why every
// route try/catches — but this covers sync throws and anything passed to next(err).
// Without a response the client waits for the platform timeout instead of an error.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: err?.message || 'Internal error' });
});

// On a serverless host (Vercel) the platform imports this module and drives the
// exported handler itself — calling listen() there binds a port nothing routes to.
// Locally we still want a real server, so only listen when not on Vercel.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 8787;
  app.listen(PORT, () => console.log(`WorkLog AI backend on http://localhost:${PORT}`));
}

export default app;
