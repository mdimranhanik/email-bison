import { schedules, logger } from "@trigger.dev/sdk/v3";
import { fetchDailyCampaignsTask } from "./fetch-campaigns.js";
import { writeDailyReportTask } from "./write-report.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Daily report → "Bison Report- Daily" spreadsheet.
// Runs alongside the weekly report (src/trigger/weekly-campaign-report), which still
// writes Monday weekly totals to the original "Bison Report" spreadsheet.
export const dailyReportTask = schedules.task({
  id: "daily-email-bison-report",
  // Tue–Sat at 09:00 UTC = 3:00 PM Bangladesh time (Asia/Dhaka, UTC+6, no DST)
  // Reports on the previous full UTC day → covers Mon–Fri. Sat/Sun are not reported.
  cron: "0 9 * * 2-6",
  run: async (payload) => {
    // ── Reporting day = yesterday (UTC) ───────────────────────────────────────
    // payload.timestamp is the scheduled fire time (today 09:00 UTC)
    const now = new Date(payload.timestamp);
    const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const date = new Date(todayMidnight - DAY_MS).toISOString().split("T")[0]; // e.g. 2026-11-17

    logger.info("Starting daily campaign report", { date });

    // ── Fetch campaigns ───────────────────────────────────────────────────────
    const fetchResult = await fetchDailyCampaignsTask.triggerAndWait({ date });

    if (!fetchResult.ok) {
      throw new Error(`fetch-campaigns task failed: ${fetchResult.error}`);
    }

    const reportPayload = fetchResult.output;

    logger.info("Campaigns fetched", { total: reportPayload.campaigns.length });

    // ── Write to Google Sheets ────────────────────────────────────────────────
    // idempotencyKey prevents duplicate rows if this run is retried on the same day
    const writeResult = await writeDailyReportTask.triggerAndWait(reportPayload, {
      idempotencyKey: `daily-report-${date}`,
    });

    if (!writeResult.ok) {
      throw new Error(`write-report task failed: ${writeResult.error}`);
    }

    const { rowsWritten } = writeResult.output;

    logger.info("Daily report complete", {
      date,
      campaignsReported: reportPayload.campaigns.length,
      rowsWrittenToSheets: rowsWritten,
    });

    return {
      date,
      campaignsReported: reportPayload.campaigns.length,
      rowsWrittenToSheets: rowsWritten,
    };
  },
});
