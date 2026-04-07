import { task, logger } from "@trigger.dev/sdk/v3";
import { google } from "googleapis";
import type { ReportPayload } from "./fetch-campaigns.js";

const DETAILS_TAB = "Campaign Details";

const DETAILS_HEADERS = [
  "Week Start",
  "Campaign Name",
  "Platform",
  "Status",
  "Emails Sent",
  "Unique Opens",
  "Unique Replies",
  "Reply Rate",
  "Bounced",
  "Bounce Rate",
  "Interested",
  "Unsubscribed",
  "Leads Contacted",
];

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "N/A";
  return ((numerator / denominator) * 100).toFixed(1) + "%";
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
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [headers] },
    });
    logger.info(`Created tab: ${tabName}`);
  }
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

    const rows: (string | number)[][] = payload.campaigns.map((c) => [
      weekStartDisplay,
      c.name,
      c.platform,
      c.status,
      c.metrics.sent,
      c.metrics.uniqueOpens,
      c.metrics.uniqueReplies,
      pct(c.metrics.uniqueReplies, c.metrics.sent),
      c.metrics.bounced,
      pct(c.metrics.bounced, c.metrics.sent),
      c.metrics.interested,
      c.metrics.unsubscribed,
      c.metrics.leadsContacted,
    ]);

    if (rows.length === 0) {
      logger.info("No CI/IN campaigns to write for this week");
      return { rowsWritten: 0 };
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: DETAILS_TAB,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });

    logger.info(`Wrote ${rows.length} campaign rows to Google Sheets`, { spreadsheetId });

    return { rowsWritten: rows.length };
  },
});
