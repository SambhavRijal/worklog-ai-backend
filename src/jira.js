// jira.js — Atlassian OAuth 2.0 (3LO) + the Jira Cloud REST calls we need.
//
// Unlike Slack's user tokens, Atlassian access tokens expire in ~1 hour. `offline_access`
// gets us a refresh token, and callJira() refreshes transparently when the stored token
// is close to expiry — so nothing above this file has to think about it.

const AUTH_BASE = 'https://auth.atlassian.com';
const API_BASE = 'https://api.atlassian.com';

// read:jira-work  — issues, JQL search, fields
// read:jira-user  — resolve the current user
// offline_access  — issue a refresh token (without it the link dies after an hour)
export const JIRA_SCOPES = 'read:jira-work read:jira-user offline_access';

export function jiraConfigured() {
  return !!(process.env.JIRA_CLIENT_ID && process.env.JIRA_CLIENT_SECRET);
}

export function jiraAuthUrl({ redirectUri, state }) {
  const p = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: process.env.JIRA_CLIENT_ID,
    scope: JIRA_SCOPES,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  return `${AUTH_BASE}/authorize?${p}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.JIRA_CLIENT_ID,
      client_secret: process.env.JIRA_CLIENT_SECRET,
      ...body,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || `Atlassian token request failed (${res.status})`);
  }
  return json;
}

export function exchangeJiraCode({ code, redirectUri }) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

export function refreshJiraToken(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

// Which Jira sites did the user grant us? Usually exactly one.
export async function accessibleResources(accessToken) {
  const res = await fetch(`${API_BASE}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Could not list Jira sites (${res.status})`);
  return res.json();
}

// --- authenticated calls, with transparent refresh ---

// Refresh when the token has under two minutes left, so a slow request can't expire
// mid-flight.
function needsRefresh(conn) {
  if (!conn.expires_at) return false;
  return new Date(conn.expires_at).getTime() - Date.now() < 120000;
}

// `conn` is a jira_connections row. `onTokens` persists rotated tokens.
export async function callJira(conn, path, { method = 'GET', body, onTokens } = {}) {
  let accessToken = conn.access_token;

  if (needsRefresh(conn) && conn.refresh_token) {
    const t = await refreshJiraToken(conn.refresh_token);
    accessToken = t.access_token;
    // Atlassian rotates refresh tokens: the new one must replace the old, or the
    // next refresh fails and the user has to reconnect by hand.
    await onTokens?.({
      accessToken: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
    });
  }

  const url = `${API_BASE}/ex/jira/${conn.cloud_id}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401) throw new Error('JIRA_UNAUTHORISED');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jira ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

export function jiraMyself(conn, opts) {
  return callJira(conn, '/rest/api/3/myself', opts);
}

// Story points live in a custom field whose id differs per site, so find it by name.
export async function findStoryPointsField(conn, opts) {
  const fields = await callJira(conn, '/rest/api/3/field', opts);
  const match = (fields || []).find((f) =>
    /^story\s*points?(\s*estimate)?$/i.test((f.name || '').trim())
  );
  return match?.id || null;
}

// What counts as "mine, in this sprint, worth reporting" — and it differs by mode:
//   check-in  — what's still ahead: To Do / In Progress
//   check-out — what moved: In Progress through Live
//
// Both are scoped to OPEN SPRINTS and to SUB-TASKS only (including sub-task bugs),
// because that's the level actual work is tracked at; parent stories are containers.
// subTaskIssueTypes() is a JQL function, so it picks up whatever the site calls its
// sub-task types rather than us hardcoding names.
const DEFAULT_CHECKIN_STATUSES = ['To Do', 'In Progress'];
const DEFAULT_CHECKOUT_STATUSES = ['In Progress', 'Review', 'In QA', 'Done', 'Live'];

function statusList(envValue, fallback) {
  const parsed = String(envValue || '').split(',').map((x) => x.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

// Status names contain spaces, so they must be quoted in JQL.
const jqlString = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function statusesFor(mode) {
  return mode === 'checkin'
    ? statusList(process.env.JIRA_CHECKIN_STATUSES, DEFAULT_CHECKIN_STATUSES)
    : statusList(process.env.JIRA_CHECKOUT_STATUSES, DEFAULT_CHECKOUT_STATUSES);
}

export function buildJql(mode, { includeSprint = true } = {}) {
  const clauses = ['assignee = currentUser()'];
  if (includeSprint) clauses.push('sprint IN openSprints()');
  clauses.push('issuetype IN subTaskIssueTypes()');
  clauses.push(`status IN (${statusesFor(mode).map(jqlString).join(', ')})`);
  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

// Atlassian replaced POST /search with POST /search/jql; try the new one and fall
// back so this works on either.
async function searchIssues(conn, { jql, fields, maxResults = 50, opts }) {
  const body = { jql, fields, maxResults };
  try {
    return await callJira(conn, '/rest/api/3/search/jql', { method: 'POST', body, ...opts });
  } catch (e) {
    if (e.message === 'JIRA_UNAUTHORISED') throw e;
    return callJira(conn, '/rest/api/3/search', { method: 'POST', body, ...opts });
  }
}

// Sprint-scoped sub-tasks assigned to me, filtered by mode. Normalised for the extension.
export async function issuesForMode(conn, { mode = 'checkout', storyPointsField, onTokens } = {}) {
  const opts = { onTokens };
  const fields = ['summary', 'status', 'issuetype', 'priority', 'timespent', 'parent'];
  if (storyPointsField) fields.push(storyPointsField);

  let data;
  try {
    data = await searchIssues(conn, { jql: buildJql(mode), fields, opts });
  } catch (e) {
    if (e.message === 'JIRA_UNAUTHORISED') throw e;
    // Sites without Jira Software have no Sprint field at all, and openSprints()
    // is then a JQL error rather than an empty result. Retry unscoped so those
    // teams still get their sub-tasks.
    data = await searchIssues(conn, { jql: buildJql(mode, { includeSprint: false }), fields, opts });
  }

  const site = (conn.site_url || '').replace(/\/$/, '');
  return (data?.issues || []).map((i) => {
    const f = i.fields || {};
    const category = f.status?.statusCategory?.key || ''; // 'new' | 'indeterminate' | 'done'
    return {
      key: i.key,
      summary: f.summary || '',
      status: f.status?.name || '',
      statusCategory: category,
      done: category === 'done',
      issueType: f.issuetype?.name || null,
      parentKey: f.parent?.key || null,
      parentSummary: f.parent?.fields?.summary || null,
      storyPoints: storyPointsField ? (f[storyPointsField] ?? null) : null,
      timeSpentSeconds: f.timespent ?? null,
      url: site ? `${site}/browse/${i.key}` : null,
    };
  });
}
