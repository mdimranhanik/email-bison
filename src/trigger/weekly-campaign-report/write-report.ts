import { task, logger } from "@trigger.dev/sdk/v3";
import { google } from "googleapis";
import type { ReportPayload } from "./fetch-campaigns.js";

// Daily rows go to the separate "Bison Report- Daily" spreadsheet, first tab.
// The old weekly data stays untouched in the original "Bison Report" spreadsheet.
// Override with the GOOGLE_SHEETS_DAILY_SPREADSHEET_ID env var if the sheet ever moves.
const DEFAULT_DAILY_SPREADSHEET_ID = "19EcD68jl_vBELJABXJsw1lftazVzgOqPGaLbLzPhQeI";
const DETAILS_TAB = "Campaign Details";
// Quoted for A1 notation — the tab name contains spaces and a hyphen
const TAB_REF = `'${DETAILS_TAB}'`;

const DETAILS_HEADERS = [
  "Date",
  "Campaign Name",
  "Platform",
  "Status",
  "Sent",
  "Unique Opens",  // NOTE: API returns 0 for all campaigns — may never populate
  "Replied",
  "Reply Rate",
  "Bounced",
  "Bounce Rate",
  "Interested",
  "Unsubscribed",
  "Client",
  "Aged Status",
];

// Platform (C) and Aged Status (N) are derived from the campaign name here in code
// (same rules as the old sheet ARRAYFORMULAs — formulas there break with #REF!
// because the script writes into the same columns).
function platformFor(name: string): string {
  if (/\bSMTP\b/i.test(name)) return "Custom SMTP";
  if (/\bIN\b/i.test(name)) return "inboxing";
  if (/\bCI\b/i.test(name)) return "cheapinboxes";
  return "";
}
function agedStatusFor(name: string): string {
  return /\(ag/i.test(name) ? "AGED" : "not aged";
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "N/A";
  // Apostrophe prefix prevents Sheets from converting "1.3%" into decimal 0.013
  return "'" + ((numerator / denominator) * 100).toFixed(1) + "%";
}

async function ensureTab(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string
): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? "");
  if (!existing.includes(DETAILS_TAB)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: DETAILS_TAB } } }] },
    });
    logger.info(`Created tab: ${DETAILS_TAB}`);
  }
  // Always overwrite row 1 with current headers — fixes stale headers from old code versions
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TAB_REF}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [DETAILS_HEADERS] },
  });
}

export const writeReportTask = task({
  id: "write-campaign-report-to-sheets",
  run: async (payload: ReportPayload): Promise<{ rowsWritten: number }> => {
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");

    const spreadsheetId =
      process.env.GOOGLE_SHEETS_DAILY_SPREADSHEET_ID || DEFAULT_DAILY_SPREADSHEET_ID;

    const clientName = process.env.CLIENT_NAME ?? "";

    const credentials = JSON.parse(
      Buffer.from(serviceAccountJson, "base64").toString("utf-8")
    );

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    await ensureTab(sheets, spreadsheetId);

    // ── Dedup check: skip individual rows already in the sheet ──────────────
    // Read columns A (Date) and B (Campaign Name) to build a composite key set.
    // A row is a duplicate only if BOTH the date AND the campaign name already exist.
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${TAB_REF}!A:B`,
    });
    const existingValues = existing.data.values ?? [];
    const existingKeys = new Set<string>(
      existingValues
        .filter((row) => row[0] && row[1])
        .map((row) => `${row[0]}|${row[1]}`)
    );
    const allRows: (string | number)[][] = payload.campaigns.map((c) => [
      `'${payload.date}`, // apostrophe prefix forces Sheets to store as text, not date serial
      c.name,
      platformFor(c.name),
      c.status,
      c.metrics.sent,
      c.metrics.uniqueOpens,
      c.metrics.replied,
      pct(c.metrics.replied, c.metrics.sent),
      c.metrics.bounced,
      pct(c.metrics.bounced, c.metrics.sent),
      c.metrics.interested,
      c.metrics.unsubscribed,
      clientName,
      agedStatusFor(c.name),
    ]);

    const deduped = allRows.filter((row) => {
      // Strip the apostrophe prefix when building the dedup key — Sheets returns the
      // raw text "2026-03-30" when reading back, not "'2026-03-30"
      const dateKey = String(row[0]).replace(/^'/, "");
      const key = `${dateKey}|${row[1]}`;
      return !existingKeys.has(key);
    });

    if (allRows.length !== deduped.length) {
      logger.info(`Skipped ${allRows.length - deduped.length} duplicate row(s) already in sheet`);
    }

    if (deduped.length === 0) {
      logger.info(`No new campaigns to write for ${payload.date}`);
      return { rowsWritten: 0 };
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${TAB_REF}!A:N`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: deduped },
    });

    logger.info(`Wrote ${deduped.length} campaign rows for ${payload.date} to Google Sheets`, {
      spreadsheetId,
    });

    return { rowsWritten: deduped.length };
  },
});
