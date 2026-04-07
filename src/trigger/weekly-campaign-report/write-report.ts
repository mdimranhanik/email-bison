import { task, logger } from "@trigger.dev/sdk/v3";
import { google } from "googleapis";
import type { ReportPayload } from "./fetch-campaigns.js";

const DETAILS_TAB = "Campaign Details";

const DETAILS_HEADERS = [
  "Week Start",
  "Campaign Name",
  "Platform",
  "Status",
  "Sent (week)",
  "Unique Opens (week)",
  "Replied (week)",
  "Reply Rate",
  "Bounced (week)",
  "Bounce Rate",
  "Interested (week)",
  "Unsubscribed (week)",
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
    // Rows already in the sheet (including header). New rows start after these.
    const currentRowCount = existingValues.length;

    const allRows: (string | number)[][] = payload.campaigns.map((c) => [
      `'${weekStartDisplay}`, // apostrophe prefix forces Sheets to store as text, not date serial
      c.name,
      c.platform, // placeholder — replaced with formula below once row numbers are known
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

    // Inject platform formula now that we know each row's sheet row number.
    // Row 1 = header, existing data = rows 2…(currentRowCount), new rows start at currentRowCount+1.
    // If the sheet is empty (no header yet), ensureTab just created it, so currentRowCount=0 and
    // the header is at row 1, meaning first new data row is row 2.
    const firstNewRow = Math.max(currentRowCount, 1) + 1;
    const rows = deduped.map((row, i) => {
      const r = firstNewRow + i;
      return [
        ...row.slice(0, 2),
        `=IFS(ISNUMBER(SEARCH("CI",B${r})),"cheap inboxes",ISNUMBER(SEARCH("CS",B${r})),"custom smtp",ISNUMBER(SEARCH(" I",B${r})),"inboxing",TRUE,"")`,
        ...row.slice(3),
      ];
    });

    if (allRows.length !== rows.length) {
      logger.info(`Skipped ${allRows.length - rows.length} duplicate row(s) already in sheet`);
    }

    if (rows.length === 0) {
      logger.info("No new campaigns to write for this week");
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
