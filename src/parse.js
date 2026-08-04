// parse.js — turn a free-form "before you start work" post into structured items.
// Default is a deterministic splitter (NO AI). AI parsing is optional and only
// used when AI_ENABLED=true. Output is an array of { text, depth, isHeader }:
//   depth    — nesting level (0 = top bullet, 1 = sub-bullet, …) from indentation
//   isHeader — true when the line has children (a category label, not a task) — these
//              are not tickable and post without a status icon.

const MARKER_LINE = /before you (start|finish) work/i;
const BULLET_PREFIX = /^([-*•▪▪︎◦·→▸‣]|\d+[.)])\s+/;

// Deterministic parser: keeps indentation so nested sub-lists survive.
export function parseItemsDeterministic(raw) {
  if (!raw) return [];
  const parsed = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const indent = (rawLine.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;
    const text = rawLine.replace(/^[ \t]*/, '').replace(BULLET_PREFIX, '').trim();
    if (!text || MARKER_LINE.test(text) || /^<@[^>]+>\s*$/.test(text)) continue;
    parsed.push({ text, indent });
  }
  // Normalize raw indent widths (2-space, 4-space, tabs…) into 0,1,2 depth levels.
  const widths = [...new Set(parsed.map((p) => p.indent))].sort((a, b) => a - b);
  parsed.forEach((p) => { p.depth = Math.max(0, widths.indexOf(p.indent)); });
  // A line is a header if the next line is nested deeper than it.
  parsed.forEach((p, i) => {
    const next = parsed[i + 1];
    p.isHeader = !!(next && next.depth > p.depth);
    delete p.indent;
  });
  return parsed;
}

// ---- Reading a posted "finish work" message back in (used at check-in) ----
//
// Slack may hand the text back with either literal emoji (our fallback `text`) or
// :shortcodes: (reconstructed from the rich_text blocks), so accept both.
const STATUS_FROM_ICON = {
  '✅': 'done', '☑️': 'done', '✔️': 'done',
  '⏳': 'in_progress', '⌛': 'in_progress',
  '❌': 'not_done', '✖️': 'not_done',
};
const STATUS_FROM_SHORTCODE = {
  white_check_mark: 'done', heavy_check_mark: 'done', ballot_box_with_check: 'done',
  hourglass_flowing_sand: 'in_progress', hourglass: 'in_progress',
  x: 'not_done', heavy_multiplication_x: 'not_done',
};

// Split a trailing status marker off a bullet's text.
function splitStatus(text) {
  const t = text.trim();
  for (const [icon, status] of Object.entries(STATUS_FROM_ICON)) {
    if (t.endsWith(icon)) return { text: t.slice(0, -icon.length).trim(), status };
  }
  const m = t.match(/:([a-z0-9_+-]+):$/i);
  if (m) {
    const status = STATUS_FROM_SHORTCODE[m[1].toLowerCase()];
    if (status) return { text: t.slice(0, -m[0].length).trim(), status };
  }
  return { text: t, status: null };
}

// Parse a posted "finish work" message into { text, depth, isHeader, status }.
export function parseFinishItems(raw) {
  if (!raw) return [];
  const lines = [];
  for (const rawLine of String(raw).split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const bare = rawLine.trim().replace(/^\*+|\*+$/g, '').trim();
    if (/^achievements$/i.test(bare)) break; // everything after is prose, not tasks
    const indent = (rawLine.match(/^[ \t]*/)[0] || '').replace(/\t/g, '    ').length;
    let text = rawLine.replace(/^[ \t]*/, '').replace(BULLET_PREFIX, '').trim();
    text = text.replace(/^\*(.+)\*$/, '$1').trim(); // strip Slack bold
    if (!text || MARKER_LINE.test(text) || /^<@[^>]+>\s*$/.test(text)) continue;
    const { text: clean, status } = splitStatus(text);
    if (clean) lines.push({ text: clean, status, indent });
  }
  const widths = [...new Set(lines.map((l) => l.indent))].sort((a, b) => a - b);
  lines.forEach((l) => { l.depth = Math.max(0, widths.indexOf(l.indent)); delete l.indent; });
  lines.forEach((l, i) => {
    const next = lines[i + 1];
    l.isHeader = !!(next && next.depth > l.depth);
    if (l.isHeader) l.status = null;
  });
  return lines;
}

// Keep what's still outstanding: ❌ not-done and ⏳ in-progress leaves, plus any
// header that still has a surviving child (so the outline structure isn't lost).
// ✅ done items are dropped — that's the whole point of the carry-over.
export function carryOverItems(items) {
  const keep = new Array(items.length).fill(false);
  const subtreeEnd = (i) => {
    const d = items[i].depth || 0;
    let e = i + 1;
    while (e < items.length && (items[e].depth || 0) > d) e++;
    return e;
  };
  items.forEach((it, i) => {
    if (!it.isHeader && (it.status === 'not_done' || it.status === 'in_progress')) keep[i] = true;
  });
  for (let i = items.length - 1; i >= 0; i--) {
    if (!items[i].isHeader) continue;
    const end = subtreeEnd(i);
    for (let j = i + 1; j < end; j++) if (keep[j]) { keep[i] = true; break; }
  }

  const out = items
    .filter((_, i) => keep[i])
    .map((it) => ({ text: it.text, depth: it.depth || 0, isHeader: !!it.isHeader }));

  // Dropping items can orphan a child under a removed parent — re-flatten so no
  // level jumps by more than one.
  out.forEach((it, i) => {
    const prevDepth = i === 0 ? -1 : out[i - 1].depth;
    if (it.depth > prevDepth + 1) it.depth = prevDepth + 1;
    if (i === 0) it.depth = 0;
  });
  out.forEach((it, i) => {
    const next = out[i + 1];
    it.isHeader = !!(next && next.depth > it.depth);
  });
  return out;
}

// Optional AI parser. Only imported/used when AI is enabled. Falls back to the
// deterministic parser on any error so the core flow never breaks.
export async function parseItemsAI(raw, marker) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content:
          `Extract the individual task items from this work-log post as a JSON ` +
          `array of short strings. No commentary, JSON only.\n\n${raw}`,
      }],
    });
    const txt = msg.content?.[0]?.text?.trim() || '[]';
    const arr = JSON.parse(txt);
    if (Array.isArray(arr) && arr.length) return arr.map(String);
  } catch (e) {
    console.warn('AI parse failed, using deterministic parser:', e.message);
  }
  return parseItemsDeterministic(raw);
}

// Always returns an array of { text, depth, isHeader }.
export async function parseItems(raw, marker) {
  let result;
  if (String(process.env.AI_ENABLED).toLowerCase() === 'true') {
    result = await parseItemsAI(raw, marker);
  } else {
    result = parseItemsDeterministic(raw);
  }
  return result.map((it) =>
    typeof it === 'string'
      ? { text: it, depth: 0, isHeader: false }
      : { text: it.text, depth: it.depth || 0, isHeader: !!it.isHeader }
  );
}

// Compose the "finish work" Slack message.
// Format matches the team's convention: a header, then one bullet per item with the
// status icon TRAILING the text, e.g.  "• Fix invoice bug ✅".
// Achievements, when provided, are appended as their own section below the bullets.
// NOTE: mood is never posted — it's captured for future analysis/storage only.
const STATUS_ICON = { done: '✅', in_progress: '⏳', not_done: '❌' };
const BULLETS = ['•', '◦', '▪︎']; // bullet glyph per nesting depth

export function composeFinishMessage({ header, items, achievements }) {
  const lines = [`*${header}*`];
  for (const it of items) {
    const depth = it.depth || 0;
    const indent = '    '.repeat(depth);                 // 4 spaces per level (Slack nesting)
    const bullet = BULLETS[Math.min(depth, BULLETS.length - 1)];
    const icon = it.isHeader ? '' : (STATUS_ICON[it.status] || ''); // headers post without a status
    lines.push(`${indent}${bullet} ${it.text}${icon ? ' ' + icon : ''}`);
  }
  if (achievements && achievements.trim()) {
    lines.push('', '*Achievements*', achievements.trim());
  }
  return lines.join('\n');
}

// Compose the same content as Slack "rich_text" blocks so it renders as a REAL
// bulleted list (proper hanging indent + true nesting), like the team's posts.
// Slack mrkdwn has no list syntax — real lists require rich_text_list elements.
const STATUS_EMOJI = { done: 'white_check_mark', in_progress: 'hourglass_flowing_sand', not_done: 'x' };

export function composeFinishBlocks({ header, items, achievements }) {
  const els = [
    { type: 'rich_text_section', elements: [{ type: 'text', text: header, style: { bold: true } }] },
  ];

  // Each contiguous run of the same depth becomes one rich_text_list with that indent.
  let list = null, curIndent = null;
  for (const it of items) {
    const inline = [{ type: 'text', text: it.text }];
    if (!it.isHeader && STATUS_EMOJI[it.status]) {
      inline.push({ type: 'text', text: ' ' }, { type: 'emoji', name: STATUS_EMOJI[it.status] });
    }
    const section = { type: 'rich_text_section', elements: inline };
    const depth = it.depth || 0;
    if (depth !== curIndent) {
      list = { type: 'rich_text_list', style: 'bullet', indent: depth, elements: [] };
      els.push(list);
      curIndent = depth;
    }
    list.elements.push(section);
  }

  if (achievements && achievements.trim()) {
    els.push(
      { type: 'rich_text_section', elements: [{ type: 'text', text: '\n' }] },
      { type: 'rich_text_section', elements: [{ type: 'text', text: 'Achievements', style: { bold: true } }] },
      { type: 'rich_text_section', elements: [{ type: 'text', text: achievements.trim() }] },
    );
  }

  return [{ type: 'rich_text', elements: els }];
}
