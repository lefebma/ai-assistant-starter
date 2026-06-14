#!/usr/bin/env node
/*
Apollo active sequences report.
Fetches "emailer_campaigns" (Apollo sequences) via Apollo API,
filters to active only, writes a CSV summary, and prints per-sequence totals.

Env:
  APOLLO_API_KEY (required) — Apollo API key
  APOLLO_BASE_URL (optional) — defaults to https://app.apollo.io/api/v1
  APOLLO_REPORT_TZ (optional) — IANA timezone for the date stamp on the CSV filename
                                  (defaults to system local, falls back to UTC)

Usage:
  APOLLO_API_KEY=$(cat ~/.apollo-api-key) node apollo-active-sequences-report.js [output_dir]
*/

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_URL = process.env.APOLLO_BASE_URL || 'https://app.apollo.io/api/v1';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

function toDateStr(d = new Date()) {
  // YYYY-MM-DD. Use APOLLO_REPORT_TZ if set, else system local.
  const tz = process.env.APOLLO_REPORT_TZ;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      ...(tz ? { timeZone: tz } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return fmt.format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function fmtPct(x) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '';
  return (Number(x) * 100).toFixed(2);
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function postJson(url, apiKey, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': apiKey
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(`Non-JSON response ${res.status} from ${url}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

async function fetchAllEmailerCampaigns(apiKey) {
  const out = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    const url = `${BASE_URL}/emailer_campaigns/search`;
    const json = await postJson(url, apiKey, { page, per_page: perPage });
    const batch = json.emailer_campaigns || [];
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
    if (page > 50) break;
  }

  return out;
}

function pickMetrics(c) {
  const openRate = c.open_rate_tracked ?? c.open_rate ?? null;
  const clickRate = c.click_rate_tracked ?? c.click_rate ?? null;
  const replyRate = c.reply_rate ?? null;
  const bounceRate = c.bounce_rate ?? null;

  return {
    name: c.name ?? '',
    steps: c.num_steps ?? '',
    lastUsed: c.last_used_at ?? '',
    delivered: c.unique_delivered ?? '',
    bounced: c.unique_bounced ?? '',
    opened: c.unique_opened ?? '',
    clicked: c.unique_clicked ?? '',
    replied: c.unique_replied ?? '',
    unsubscribed: c.unique_unsubscribed ?? '',
    openRatePct: fmtPct(openRate),
    clickRatePct: fmtPct(clickRate),
    replyRatePct: fmtPct(replyRate),
    bounceRatePct: fmtPct(bounceRate),
    performingPoorly: c.is_performing_poorly === true ? 'true' : 'false'
  };
}

function toCsv(rows) {
  const header = [
    'Sequence Name','Steps','Last Used','Delivered','Bounced','Opened','Clicked','Replied','Unsubscribed',
    'Open Rate %','Click Rate %','Reply Rate %','Bounce Rate %','Performing Poorly'
  ];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    const line = [
      r.name, r.steps, r.lastUsed, r.delivered, r.bounced, r.opened, r.clicked, r.replied, r.unsubscribed,
      r.openRatePct, r.clickRatePct, r.replyRatePct, r.bounceRatePct, r.performingPoorly
    ].map(csvEscape).join(',');
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}

function summarize(rows) {
  const parts = [];
  for (const r of rows) {
    parts.push(
      `- ${r.name} (steps: ${r.steps}, last used: ${r.lastUsed || 'n/a'})\n` +
      `  delivered ${r.delivered}, opened ${r.opened} (open ${r.openRatePct || 'n/a'}%), clicked ${r.clicked} (click ${r.clickRatePct || 'n/a'}%), replied ${r.replied} (reply ${r.replyRatePct || 'n/a'}%), bounced ${r.bounced} (bounce ${r.bounceRatePct || 'n/a'}%), unsub ${r.unsubscribed}, performingPoorly=${r.performingPoorly}`
    );
  }
  const sum = (k) => rows.reduce((acc, r) => acc + (Number(r[k]) || 0), 0);
  const totals = {
    delivered: sum('delivered'),
    opened: sum('opened'),
    clicked: sum('clicked'),
    replied: sum('replied'),
    bounced: sum('bounced'),
    unsubscribed: sum('unsubscribed')
  };
  return { perSequence: parts.join('\n'), totals };
}

async function main() {
  const apiKey = requireEnv('APOLLO_API_KEY');
  const outDir = process.argv[2] || path.join(os.homedir(), 'apollo-reports');

  const dateStr = toDateStr(new Date());
  const fileName = `apollo-active-sequences-${dateStr}.csv`;
  const outPath = path.join(outDir, fileName);

  const all = await fetchAllEmailerCampaigns(apiKey);
  const active = all.filter(c => c && c.active === true && c.archived !== true);

  const rows = active
    .map(pickMetrics)
    .sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, toCsv(rows), 'utf8');

  const { perSequence, totals } = summarize(rows);

  const summaryText = [
    `Apollo active sequences report (${dateStr})`,
    `Saved: ${outPath}`,
    `Active sequences: ${rows.length}`,
    `Totals (active only): delivered ${totals.delivered}, opened ${totals.opened}, clicked ${totals.clicked}, replied ${totals.replied}, bounced ${totals.bounced}, unsubscribed ${totals.unsubscribed}`,
    '',
    perSequence
  ].join('\n');

  console.log(summaryText);
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
