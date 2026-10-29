// jira.js — Atlassian OAuth 2.0 (3LO) + the Jira Cloud REST calls we need.
//
// Unlike Slack's user tokens, Atlassian access tokens expire in ~1 hour. `offline_access`
// gets us a refresh token, and callJira() refreshes transparently when the stored token
// is close to expiry — so nothing above this file has to think about it.

import { computePace, localDate } from './pace.js';

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

// Which issue types count as "the level work is tracked at"?
//
// subTaskIssueTypes() only matches types Jira has FLAGGED as sub-tasks. A type named
// e.g. "Subtask Bug" that was configured as a standard type is silently excluded by it,
// which looks exactly like "no issues today". So discover the real names instead:
// anything flagged subtask, plus anything whose name reads sub-task-ish.
// Every issue type on the site, with Jira's own subtask flag — for diagnostics.
export async function listIssueTypes(conn, opts) {
  const types = await callJira(conn, '/rest/api/3/issuetype', opts);
  const seen = new Map();
  for (const t of types || []) {
    const name = (t.name || '').trim();
    if (name && !seen.has(name)) seen.set(name, { name, subtask: t.subtask === true });
  }
  return [...seen.values()];
}

export async function findSubtaskIssueTypes(conn, opts) {
  const types = await callJira(conn, '/rest/api/3/issuetype', opts);
  const names = new Set();
  for (const t of types || []) {
    const name = (t.name || '').trim();
    if (!name) continue;
    if (t.subtask === true || /sub[\s_-]*task/i.test(name)) names.add(name);
  }
  return [...names];
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
//   check-in  — what's still ahead: To Do / In Progress, whenever it last moved
//   check-out — what moved TODAY: In Progress through Live, and status changed today
//
// Check-out needs the date filter or you get the sprint's entire Done column every
// evening instead of the handful you actually finished. Check-in deliberately has no
// date filter: what's still on your plate doesn't depend on when it last changed.
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

// When did this ticket reach Done? statuscategorychangedate is when it last changed
// status CATEGORY, so it's the Done moment for anything currently Done; resolutiondate
// covers workflows that set a resolution instead.
function doneDateOf(f, offsetMin) {
  if (f?.status?.statusCategory?.key !== 'done') return null;
  return localDate(f.statuscategorychangedate || f.resolutiondate, offsetMin);
}

export function statusesFor(mode) {
  return mode === 'checkin'
    ? statusList(process.env.JIRA_CHECKIN_STATUSES, DEFAULT_CHECKIN_STATUSES)
    : statusList(process.env.JIRA_CHECKOUT_STATUSES, DEFAULT_CHECKOUT_STATUSES);
}

export function buildJql(mode, { includeSprint = true, issueTypes = null, clock = null } = {}) {
  const clauses = ['assignee = currentUser()'];
  if (includeSprint) clauses.push('sprint IN openSprints()');
  // Explicit names when we've discovered them (a superset of subTaskIssueTypes()),
  // otherwise fall back to the JQL function.
  clauses.push(issueTypes?.length
    ? `issuetype IN (${issueTypes.map(jqlString).join(', ')})`
    : 'issuetype IN subTaskIssueTypes()');
  clauses.push(`status IN (${statusesFor(mode).map(jqlString).join(', ')})`);
  // "Today" is the user's day, from the clock the extension sent. A relative offset
  // ("-345m" = since 345 minutes ago) doesn't depend on any timezone setting, so it
  // can't drift from the user's midnight the way startOfDay() does when the Jira
  // profile's timezone is wrong. No clock (old extension): fall back to startOfDay().
  if (mode !== 'checkin') {
    clauses.push(clock
      ? `status CHANGED AFTER -${Math.max(1, clock.minutesSinceMidnight)}m`
      : 'status CHANGED AFTER startOfDay()');
  }
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

// A few of my issues with their REAL type and status names — the fastest way to see
// why a status/type filter matches nothing (e.g. "In progress" vs "In Progress",
// or a bug type that isn't flagged as a sub-task).
export async function sampleMine(conn, opts, { limit = 15 } = {}) {
  const jql = 'assignee = currentUser() AND sprint IN openSprints() ORDER BY updated DESC';
  try {
    const r = await searchIssues(conn, {
      jql, fields: ['summary', 'status', 'issuetype', 'parent'], maxResults: limit, opts,
    });
    return (r?.issues || []).map((i) => ({
      key: i.key,
      type: i.fields?.issuetype?.name || null,
      isSubtaskType: i.fields?.issuetype?.subtask === true,
      status: i.fields?.status?.name || null,
      category: i.fields?.status?.statusCategory?.key || null,
      hasParent: !!i.fields?.parent,
    }));
  } catch (e) {
    return `error: ${e.message.slice(0, 160)}`;
  }
}

// How many issues a JQL matches. Atlassian's newer /search/jql omits `total`, so
// asking for one row and reading issues.length silently reports 1 for everything —
// count the rows instead, capped.
export async function countFor(conn, jql, opts, { cap = 100 } = {}) {
  try {
    const r = await searchIssues(conn, { jql, fields: ['summary'], maxResults: cap, opts });
    const n = r?.issues?.length ?? 0;
    return n >= cap ? `${cap}+` : n;
  } catch (e) {
    return `error: ${e.message.slice(0, 160)}`;
  }
}

// Run one arbitrary JQL and show what comes back — for bisecting a query that
// matches nothing. Read-only.
export async function runJql(conn, jql, opts, { limit = 10 } = {}) {
  try {
    const r = await searchIssues(conn, {
      jql, fields: ['summary', 'status', 'issuetype'], maxResults: limit, opts,
    });
    return {
      matched: r?.issues?.length ?? 0,
      issues: (r?.issues || []).map((i) => ({
        key: i.key, type: i.fields?.issuetype?.name, status: i.fields?.status?.name,
      })),
    };
  } catch (e) {
    return { error: e.message.slice(0, 300) };
  }
}

// Sprint-scoped sub-tasks assigned to me, filtered by mode. Normalised for the extension.
export async function issuesForMode(conn, { mode = 'checkout', storyPointsField, issueTypes, onTokens, clock = null } = {}) {
  const opts = { onTokens };
  const fields = ['summary', 'status', 'issuetype', 'priority', 'timespent', 'parent', 'statuscategorychangedate', 'resolutiondate'];
  if (storyPointsField) fields.push(storyPointsField);

  let data;
  try {
    data = await searchIssues(conn, { jql: buildJql(mode, { issueTypes, clock }), fields, opts });
  } catch (e) {
    if (e.message === 'JIRA_UNAUTHORISED') throw e;
    // Sites without Jira Software have no Sprint field at all, and openSprints()
    // is then a JQL error rather than an empty result. Retry unscoped so those
    // teams still get their sub-tasks.
    data = await searchIssues(conn, { jql: buildJql(mode, { includeSprint: false, issueTypes, clock }), fields, opts });
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
      // Moved to Done today (user's day) — these are the points earned today.
      doneToday: !!clock && doneDateOf(f, clock.offsetMin) === clock.today,
      url: site ? `${site}/browse/${i.key}` : null,
    };
  });
}

// ---- This month's task weight ----
//
// Story points count toward the month in a custom field ("Task Weight Counted As" or
// similar), not by sprint or by when the status changed. So: every issue assigned to
// me whose counted-as value falls in the current month, story points summed.
// Discovered by name because the custom field id differs per site.
// Sites often carry several same-named fields (company- and team-managed copies), and
// only one of them is actually filled in — so collect every match, not the first.
export async function findMonthWeightFields(conn, opts) {
  const fields = await callJira(conn, '/rest/api/3/field', opts);
  const pick = (re) => (fields || [])
    .filter((f) => re.test((f.name || '').trim()))
    .map((f) => ({ id: f.id, name: f.name, type: f.schema?.type || null }));
  return {
    month: pick(/task\s*weight\s*counted/i),
    points: pick(/^story\s*points?(\s*estimate)?$/i),
  };
}

// Page through a search. /search/jql pages by nextPageToken, the old /search by startAt.
async function searchAll(conn, { jql, fields, opts, cap = 1000 }) {
  const out = [];
  try {
    let nextPageToken;
    do {
      const body = { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) };
      const r = await callJira(conn, '/rest/api/3/search/jql', { method: 'POST', body, ...opts });
      out.push(...(r?.issues || []));
      nextPageToken = r?.isLast ? null : r?.nextPageToken;
    } while (nextPageToken && out.length < cap);
    return out;
  } catch (e) {
    if (e.message === 'JIRA_UNAUTHORISED') throw e;
    out.length = 0;
    let startAt = 0;
    for (;;) {
      const body = { jql, fields, maxResults: 100, startAt };
      const r = await callJira(conn, '/rest/api/3/search', { method: 'POST', body, ...opts });
      const page = r?.issues || [];
      out.push(...page);
      startAt += page.length;
      if (!page.length || startAt >= (r?.total ?? 0) || out.length >= cap) return out;
    }
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Does a non-date field value (a select option like "October 2026", or text) name
// the given month? Accepts "2026-10", "Oct 2026", "October", etc.
function valueInMonth(raw, year, month0) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const s = String(v?.value ?? v?.name ?? v ?? '').trim().toLowerCase();
  if (!s) return false;
  const iso = s.match(/(\d{4})[-/.](\d{1,2})/);
  if (iso) return +iso[1] === year && +iso[2] - 1 === month0;
  const named = MONTHS.findIndex((m) => s.includes(m));
  if (named === -1) return false;
  const y = s.match(/\b(\d{4})\b/);
  return named === month0 && (!y || +y[1] === year);
}

export async function monthWeight(conn, { storyPointsField, onTokens, clock, target = null } = {}) {
  const opts = { onTokens };
  const found = await findMonthWeightFields(conn, opts);
  if (!found.month.length) return { found: false };

  // The stored story-points field first, then any other same-named field.
  const spIds = [...new Set([storyPointsField, ...found.points.map((f) => f.id)].filter(Boolean))];
  if (!spIds.length) return { found: true, field: found.month[0].name, noStoryPoints: true };

  const cfRef = (f) => (f.id.startsWith('customfield_') ? `cf[${f.id.slice(12)}]` : `"${f.name}"`);
  const fields = [
    'summary', 'issuetype', 'status', 'timespent', 'timeoriginalestimate',
    'statuscategorychangedate', 'resolutiondate', ...spIds, ...found.month.map((f) => f.id),
  ];
  // The user's month, from their clock — not the server's or Jira's.
  const year = clock.year;
  const month0 = clock.month0;

  const dateFields = found.month.filter((f) => f.type === 'date' || f.type === 'datetime');
  const otherFields = found.month.filter((f) => !dateFields.includes(f));
  const byKey = new Map();

  if (dateFields.length) {
    // Explicit dates for the user's month rather than startOfMonth(), which follows
    // the Jira profile's timezone. Date fields carry no time, so these are exact.
    const range = dateFields
      .map((f) => `(${cfRef(f)} >= "${clock.monthStart}" AND ${cfRef(f)} < "${clock.nextMonthStart}")`)
      .join(' OR ');
    const jql = `assignee = currentUser() AND (${range})`;
    for (const i of await searchAll(conn, { jql, fields, opts })) byKey.set(i.key, i);
  }
  if (otherFields.length) {
    // Select/text: JQL can't range over it, so fetch mine with a value and match here.
    const any = otherFields.map((f) => `${cfRef(f)} IS NOT EMPTY`).join(' OR ');
    const jql = `assignee = currentUser() AND (${any}) AND updated >= -100d`;
    for (const i of await searchAll(conn, { jql, fields, opts })) {
      if (otherFields.some((f) => valueInMonth(i.fields?.[f.id], year, month0))) byKey.set(i.key, i);
    }
  }

  // Per issue, the first story-points field that holds a number.
  const pointsOf = (i) => {
    for (const id of spIds) {
      const v = i.fields?.[id];
      if (v != null && v !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };

  let points = 0, withPoints = 0, bugCount = 0, timeSpentSeconds = 0, estimateSeconds = 0;
  const usedSp = new Set();
  for (const i of byKey.values()) {
    // Bug sub-task types ("Bug", "Sub-bug", "Bug Sub-task") all count as bugs.
    if (/bug/i.test(i.fields?.issuetype?.name || '')) bugCount += 1;
    timeSpentSeconds += Number(i.fields?.timespent) || 0;
    estimateSeconds += Number(i.fields?.timeoriginalestimate) || 0;
    const sp = pointsOf(i);
    if (sp == null) continue;
    points += sp; withPoints += 1;
    usedSp.add(spIds.find((id) => i.fields?.[id] != null));
  }

  // Remember the story-points field that actually carries values, so the sprint
  // panel's chips use the right one too.
  const best = [...usedSp][0] || null;

  const site = (conn.site_url || '').replace(/\/$/, '');
  const pace = computePace({
    issues: [...byKey.values()].map((i) => ({
      key: i.key,
      summary: i.fields?.summary || '',
      points: pointsOf(i),
      doneDate: doneDateOf(i.fields, clock.offsetMin),
      timeSpentSeconds: Number(i.fields?.timespent) || 0,
      url: site ? `${site}/browse/${i.key}` : null,
    })),
    clock,
    totalPoints: Math.round(points * 100) / 100,
    target,
  });

  return {
    found: true,
    field: found.month[0].name,
    month: `${year}-${String(month0 + 1).padStart(2, '0')}`,
    points: Math.round(points * 100) / 100,
    issueCount: byKey.size,
    withPoints,
    bugCount,
    timeSpentSeconds,
    estimateSeconds,
    storyPointsFieldUsed: best,
    pace,
    // For diagnosing a zero: which fields were considered.
    fieldsChecked: { month: found.month, points: spIds },
  };
}
