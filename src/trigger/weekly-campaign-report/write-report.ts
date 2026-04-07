import { task, logger } from "@trigger.dev/sdk/v3";
import { google } from "googleapis";
import type { ReportPayload } from "./fetch-campaigns.js";

const DETAILS_TAB = "Campaign Details";

const DETAILS_HEADERS = [
  "Week Start",
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
];

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "N/A";
  // Apostrophe prefix prevents Sheets from converting "1.3%" into decimal 0.013
  return "'" + ((numerator / denominator) * 100).toFixed(1) + "%";
}

function formatDate(iso: string): string {
  return iso.split("T")[0];
}

async function ensureTab(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tabName: string,
  headers: string[]
): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? "");
  if (!existing.includes(tabName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
    logger.info(`Created tab: ${tabName}`);
  }
  // Always overwrite row 1 with current headers — fixes stale headers from old code versions
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });
}

export const writeReportTask = task({
  id: "write-campaign-report-to-sheets",
  run: async (payload: ReportPayload): Promise<{ rowsWritten: number }> => {
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");

    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is not set");

    const credentials = JSON.parse(
      Buffer.from(serviceAccountJson, "base64").toString("utf-8")
    );

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    await ensureTab(sheets, spreadsheetId, DETAILS_TAB, DETAILS_HEADERS);

    const weekStartDisplay = formatDate(payload.weekStart);

    // ── Dedup check: skip individual rows already in the sheet ──────────────
    // Read columns A (Week Start) and B (Campaign Name) to build a composite key set.
    // A row is a duplicate only if BOTH the date AND the campaign name already exist.
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${DETAILS_TAB}!A:B`, // Week Start + Campaign Name
    });
    const existingValues = existing.data.values ?? [];
    const existingKeys = new Set<string>(
      existingValues
        .filter((row) => row[0] && row[1])
        .map((row) => `${row[0]}|${row[1]}`)
    );
    const allRows: (string | number)[][] = payload.campaigns.map((c) => [
      `'${weekStartDisplay}`, // apostrophe prefix forces Sheets to store as text, not date serial
      c.name,
      c.platform,
      c.status,
      c.metrics.sent,
      c.metrics.uniqueOpens,
      c.metrics.replied,
      pct(c.metrics.replied, c.metrics.sent),
      c.metrics.bounced,
      pct(c.metrics.bounced, c.metrics.sent),
      c.metrics.interested,
      c.metrics.unsubscribed,
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
      logger.info("No new campaigns to write for this week");
      return { rowsWritten: 0 };
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: DETAILS_TAB,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: deduped },
    });

    logger.info(`Wrote ${deduped.length} campaign rows to Google Sheets`, { spreadsheetId });

    return { rowsWritten: deduped.length };
  },
});
