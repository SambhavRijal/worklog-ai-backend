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

// Issues assigned to me whose STATUS changed today — "what did I actually move".
// `updated` would also catch comments and field edits, which isn't the same thing.
const TODAY_JQL =
  'assignee = currentUser() AND status CHANGED AFTER startOfDay() ORDER BY updated DESC';

// Atlassian replaced POST /search with POST /search/jql; try the new one and fall
// back so this works on either.
async function searchIssues(conn, { jql, fields, maxResults = 50, opts }) {
  try {
    return await callJira(conn, '/rest/api/3/search/jql', {
      method: 'POST', body: { jql, fields, maxResults }, ...opts,
    });
  } catch (e) {
    if (e.message === 'JIRA_UNAUTHORISED') throw e;
    return callJira(conn, '/rest/api/3/search', {
      method: 'POST', body: { jql, fields, maxResults }, ...opts,
    });
  }
}

// Today's issues, normalised for the extension.
export async function todaysIssues(conn, { storyPointsField, onTokens } = {}) {
  const opts = { onTokens };
  const fields = ['summary', 'status', 'issuetype', 'priority', 'timespent', 'parent'];
  if (storyPointsField) fields.push(storyPointsField);

  const data = await searchIssues(conn, { jql: TODAY_JQL, fields, opts });
  const site = (conn.site_url || '').replace(/\/$/, '');

  return (data?.issues || []).map((i) => {
    const f = i.fields || {};
    const statusName = f.status?.name || '';
    const category = f.status?.statusCategory?.key || ''; // 'new' | 'indeterminate' | 'done'
    return {
      key: i.key,
      summary: f.summary || '',
      status: statusName,
      statusCategory: category,
      done: category === 'done',
      issueType: f.issuetype?.name || null,
      storyPoints: storyPointsField ? (f[storyPointsField] ?? null) : null,
      timeSpentSeconds: f.timespent ?? null,
      url: site ? `${site}/browse/${i.key}` : null,
    };
  });
}
