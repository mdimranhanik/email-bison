/**
 * One-shot script to run the weekly campaign report right now.
 * Uses the same logic as the Trigger.dev tasks but runs locally.
 * Usage: node run-report-now.mjs [weekStart] [weekEnd]
 * Example: node run-report-now.mjs 2026-03-30 2026-04-05
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

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY = process.env.EMAIL_BISON_API_KEY;
const INSTANCE_URL = (process.env.EMAIL_BISON_INSTANCE_URL ?? "https://dedi.emailbison.com").replace(/\/$/, "");
const BASE_URL = `${INSTANCE_URL}/api`;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const DETAILS_TAB = "Campaign Details";
const DETAILS_HEADERS = [
  "Week Start", "Campaign Name", "Platform", "Status",
  "Sent (week)", "Unique Opens (week)", "Replied (week)", "Reply Rate",
  "Bounced (week)", "Bounce Rate", "Interested (week)", "Unsubscribed (week)",
];

if (!API_KEY) throw new Error("EMAIL_BISON_API_KEY not set");
if (!SA_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
if (!SPREADSHEET_ID) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID not set");

// ── Date window ───────────────────────────────────────────────────────────────
function computeLastWeek() {
  const now = new Date();
  // Roll back to last Monday 00:00 UTC
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Mon=0 days back, Tue=1, ...
  const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToLastMonday));
  const weekStart = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEnd = new Date(thisMonday.getTime() - 1);
  return { weekStart, weekEnd };
}

let weekStart, weekEnd;
if (process.argv[2] && process.argv[3]) {
  weekStart = new Date(`${process.argv[2]}T00:00:00.000Z`);
  weekEnd = new Date(`${process.argv[3]}T23:59:59.999Z`);
} else {
  ({ weekStart, weekEnd } = computeLastWeek());
}

const weekStartISO = weekStart.toISOString();
const weekEndISO = weekEnd.toISOString();
const weekStartDisplay = weekStartISO.split("T")[0];
const startDate = weekStartISO.split("T")[0];
const endDate = weekEndISO.split("T")[0];

console.log(`\nReporting week: ${weekStartDisplay} → ${endDate}`);

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
}

function sumSeries(series, label) {
  const s = series.find(s => s.label.toLowerCase() === label.toLowerCase());
  if (!s) return 0;
  return s.dates.reduce((acc, [, val]) => acc + (val ?? 0), 0);
}

async function fetchWeeklyStats(campaignId) {
  try {
    const url = `${BASE_URL}/campaigns/${campaignId}/line-area-chart-stats?start_date=${startDate}&end_date=${endDate}`;
    const res = await apiFetch(url);
    const body = await res.json();
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

// ── Fetch campaigns ───────────────────────────────────────────────────────────
console.log("\n[1/3] Fetching campaigns...");
const allCampaigns = [];
let page = 1;
while (page <= 500) {
  const res = await apiFetch(`${BASE_URL}/campaigns?page=${page}`);
  const body = await res.json();
  if (!body.data || body.data.length === 0) break;
  allCampaigns.push(...body.data);
  if (!body.links?.next) break;
  page++;
}
console.log(`  Found ${allCampaigns.length} total campaigns`);

// Filter
const seenIds = new Set();
const relevant = [];
for (const c of allCampaigns) {
  if (seenIds.has(c.id)) continue;
  if (c.status === "active") {
    // always include
  } else if (["completed", "paused", "archived"].includes(c.status)) {
    const updated = new Date(c.updated_at);
    if (updated < weekStart || updated >= weekEnd) continue;
  } else {
    continue; // draft etc.
  }
  seenIds.add(c.id);
  relevant.push(c);
}
console.log(`  ${relevant.length} campaigns relevant to this week`);

// ── Fetch weekly stats ────────────────────────────────────────────────────────
console.log("\n[2/3] Fetching weekly stats per campaign...");
const campaigns = [];
for (const c of relevant) {
  process.stdout.write(`  ${c.name} ... `);
  const metrics = await fetchWeeklyStats(c.id);
  console.log(`sent=${metrics.sent}`);
  campaigns.push({ id: c.id, name: c.name, status: c.status, platform: "", metrics });
}

// ── Write to Google Sheets ────────────────────────────────────────────────────
console.log("\n[3/3] Writing to Google Sheets...");

const credentials = JSON.parse(Buffer.from(SA_JSON, "base64").toString("utf-8"));
const auth = new google.auth.GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });

// Ensure tab exists
const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
const existingTabs = (meta.data.sheets ?? []).map(s => s.properties?.title ?? "");
if (!existingTabs.includes(DETAILS_TAB)) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: DETAILS_TAB } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${DETAILS_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [DETAILS_HEADERS] },
  });
  console.log("  Created 'Campaign Details' tab with headers");
}

// Dedup check: date + campaign name composite key
const existingData = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: `${DETAILS_TAB}!A:B`,
});
const existingKeys = new Set(
  (existingData.data.values ?? [])
    .filter(row => row[0] && row[1])
    .map(row => `${row[0]}|${row[1]}`)
);

function pct(num, den) {
  if (den === 0) return "N/A";
  return ((num / den) * 100).toFixed(1) + "%";
}

const allRows = campaigns.map(c => [
  weekStartDisplay, c.name, c.platform, c.status,
  c.metrics.sent, c.metrics.uniqueOpens,
  c.metrics.replied, pct(c.metrics.replied, c.metrics.sent),
  c.metrics.bounced, pct(c.metrics.bounced, c.metrics.sent),
  c.metrics.interested, c.metrics.unsubscribed,
]);

const newRows = allRows.filter(row => !existingKeys.has(`${row[0]}|${row[1]}`));
const skipped = allRows.length - newRows.length;
if (skipped > 0) console.log(`  Skipped ${skipped} duplicate row(s)`);

if (newRows.length === 0) {
  console.log("  Nothing new to write — all campaigns already in sheet.");
} else {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: DETAILS_TAB,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: newRows },
  });
  console.log(`  Wrote ${newRows.length} row(s) to Google Sheets ✓`);
}

console.log("\nDone.");
