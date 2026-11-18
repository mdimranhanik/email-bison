/**
 * Run the DAILY campaign report locally — same logic as the Trigger.dev tasks.
 * Writes one set of rows per day to the "Bison Report- Daily" sheet.
 *
 * Usage:
 *   node run-report-now.mjs                         → yesterday (UTC)
 *   node run-report-now.mjs 2026-11-17              → one day
 *   node run-report-now.mjs 2026-11-16 2026-11-17   → every day in the range (backfill)
 *
 * Re-running a day is safe: rows already in the sheet (same Date + Campaign Name) are skipped.
 */
import { readFileSync } from "fs";
import { google } from "googleapis";

// ── Load .env manually ────────────────────────────────────────────────────────
const envText = readFileSync(".env", "utf-8");
for (const line of envText.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

// ── Config (keep in sync with src/trigger/weekly-campaign-report/*.ts) ───────
const API_KEY = process.env.EMAIL_BISON_API_KEY;
const INSTANCE_URL = (process.env.EMAIL_BISON_INSTANCE_URL ?? "https://dedi.emailbison.com").replace(/\/$/, "");
const BASE_URL = `${INSTANCE_URL}/api`;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_DAILY_SPREADSHEET_ID || "19EcD68jl_vBELJABXJsw1lftazVzgOqPGaLbLzPhQeI";
const DETAILS_TAB = "Campaign Details";
const TAB_REF = `'${DETAILS_TAB}'`;
const DETAILS_HEADERS = [
  "Date", "Campaign Name", "Platform", "Status",
  "Sent", "Unique Opens", "Replied", "Reply Rate",
  "Bounced", "Bounce Rate", "Interested", "Unsubscribed",
  "Client", "Aged Status",
];
// Platform (C) and Aged Status (N) are derived from the campaign name here in code
// (same rules as the old sheet ARRAYFORMULAs — formulas there break with #REF!
// because the script writes into the same columns).
function platformFor(name) {
  if (/\bSMTP\b/i.test(name)) return "Custom SMTP";
  if (/\bIN\b/i.test(name)) return "inboxing";
  if (/\bCI\b/i.test(name)) return "cheapinboxes";
  return "";
}
function agedStatusFor(name) {
  return /\(ag/i.test(name) ? "AGED" : "not aged";
}
const CLIENT_NAME = process.env.CLIENT_NAME ?? "";
const LOOKBACK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

if (!API_KEY) throw new Error("EMAIL_BISON_API_KEY not set");
if (!SA_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");

// ── Dates to run ──────────────────────────────────────────────────────────────
function yesterdayUTC() {
  const now = new Date();
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayMidnight - DAY_MS).toISOString().split("T")[0];
}
const first = process.argv[2] ?? yesterdayUTC();
const last = process.argv[3] ?? first;
const dates = [];
for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += DAY_MS) {
  const d = new Date(t);
  // Sat (6) / Sun (0) are not reported on their own — Monday's row covers them
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
  dates.push(d.toISOString().split("T")[0]);
}
if (dates.length === 0) throw new Error(`No weekdays in range: ${first} → ${last} (Sat/Sun are folded into Monday)`);

// ── Email Bison helpers ───────────────────────────────────────────────────────
async function apiFetch(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
    });
    if (res.ok) return res;
    if (res.status === 429) {
      const wait = parseInt(res.headers.get("Retry-After") ?? "10", 10);
      console.warn(`  Rate limited — waiting ${wait}s`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`Email Bison API ${res.status} — ${url}`);
  }
  throw new Error(`Email Bison API failed after 3 attempts: ${url}`);
}

function sumSeries(series, label) {
  const s = series.find(s => s.label.toLowerCase() === label.toLowerCase());
  if (!s) return 0;
  return s.dates.reduce((acc, [, val]) => acc + (val ?? 0), 0);
}

async function fetchStats(campaignId, from, date) {
  try {
    const url = `${BASE_URL}/campaigns/${campaignId}/line-area-chart-stats?start_date=${from}&end_date=${date}`;
    const body = await (await apiFetch(url)).json();
    const series = body.data ?? [];
    return {
      sent: sumSeries(series, "Sent"),
      uniqueOpens: sumSeries(series, "Unique Opens"),
      replied: sumSeries(series, "Replied"),
      bounced: sumSeries(series, "Bounced"),
      interested: sumSeries(series, "Interested"),
      unsubscribed: sumSeries(series, "Unsubscribed"),
    };
  } catch {
    console.warn(`  Could not fetch stats for campaign ${campaignId} — using zeros`);
    return { sent: 0, uniqueOpens: 0, replied: 0, bounced: 0, interested: 0, unsubscribed: 0 };
  }
}

function pct(num, den) {
  if (den === 0) return "N/A";
  // Apostrophe prefix prevents Sheets from converting "1.3%" into decimal 0.013
  return "'" + ((num / den) * 100).toFixed(1) + "%";
}

// ── Fetch the campaign list once ──────────────────────────────────────────────
console.log("\nFetching campaigns...");
const allCampaigns = [];
let page = 1;
while (page <= 500) {
  const body = await (await apiFetch(`${BASE_URL}/campaigns?page=${page}`)).json();
  if (!body.data || body.data.length === 0) break;
  allCampaigns.push(...body.data);
  if (!body.links?.next) break;
  page++;
}
console.log(`  Found ${allCampaigns.length} total campaigns`);

// ── Sheets setup ──────────────────────────────────────────────────────────────
const credentials = JSON.parse(Buffer.from(SA_JSON, "base64").toString("utf-8"));
const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });

const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
const existingTabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? "");
if (!existingTabs.includes(DETAILS_TAB)) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: DETAILS_TAB } } }] },
  });
  console.log(`  Created '${DETAILS_TAB}' tab`);
}
await sheets.spreadsheets.values.update({
  spreadsheetId: SPREADSHEET_ID,
  range: `${TAB_REF}!A1`,
  valueInputOption: "RAW",
  requestBody: { values: [DETAILS_HEADERS] },
});

// ── One pass per day ──────────────────────────────────────────────────────────
for (const date of dates) {
  // Monday's row also covers Saturday + Sunday (weekends aren't reported on their own)
  const statsFrom = new Date(`${date}T00:00:00Z`).getUTCDay() === 1
    ? new Date(Date.parse(`${date}T00:00:00Z`) - 2 * DAY_MS).toISOString().split("T")[0]
    : date;
  console.log(`\n=== ${date}${statsFrom !== date ? ` (stats ${statsFrom} → ${date}, incl. weekend)` : ""} ===`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  const lookbackStart = new Date(Date.parse(`${date}T00:00:00Z`) - (LOOKBACK_DAYS - 1) * DAY_MS);

  const relevant = allCampaigns.filter(c => {
    if (c.status === "active") return true;
    if (!["completed", "paused", "archived"].includes(c.status)) return false;
    const updated = new Date(c.updated_at);
    return updated >= lookbackStart && updated <= dayEnd;
  });
  console.log(`  ${relevant.length} candidate campaigns`);

  const campaigns = [];
  let skippedEmpty = 0;
  for (const c of relevant) {
    const m = await fetchStats(c.id, statsFrom, date);
    const active = m.sent + m.uniqueOpens + m.replied + m.bounced + m.interested + m.unsubscribed > 0;
    if (c.status !== "active" && !active) { skippedEmpty++; continue; }
    console.log(`  ${c.name}\n    sent=${m.sent} | replied=${m.replied} | bounced=${m.bounced} | interested=${m.interested} | unsubscribed=${m.unsubscribed}`);
    campaigns.push({ name: c.name, status: c.status, metrics: m });
  }
  if (skippedEmpty) console.log(`  Skipped ${skippedEmpty} inactive campaign(s) with no activity`);

  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${TAB_REF}!A:B` });
  const existingKeys = new Set((existing.data.values ?? []).filter(r => r[0] && r[1]).map(r => `${r[0]}|${r[1]}`));

  const rows = campaigns
    .filter(c => !existingKeys.has(`${date}|${c.name}`))
    .map(c => [
      `'${date}`, c.name, platformFor(c.name), c.status,
      c.metrics.sent, c.metrics.uniqueOpens,
      c.metrics.replied, pct(c.metrics.replied, c.metrics.sent),
      c.metrics.bounced, pct(c.metrics.bounced, c.metrics.sent),
      c.metrics.interested, c.metrics.unsubscribed,
      CLIENT_NAME, agedStatusFor(c.name),
    ]);
  const skippedDup = campaigns.length - rows.length;
  if (skippedDup) console.log(`  Skipped ${skippedDup} row(s) already in sheet`);

  if (rows.length === 0) {
    console.log("  Nothing new to write.");
    continue;
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_REF}!A:N`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
  console.log(`  Wrote ${rows.length} row(s) ✓`);
}

console.log("\nDone.");
