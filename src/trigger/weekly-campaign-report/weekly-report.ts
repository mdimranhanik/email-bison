import { schedules, logger } from "@trigger.dev/sdk/v3";
import { fetchCampaignsTask } from "./fetch-campaigns.js";
import { writeReportTask } from "./write-report.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Task id kept as "weekly-email-bison-report" so Trigger.dev keeps the same task,
// schedule and run history — it now runs DAILY.
export const dailyReportTask = schedules.task({
  id: "weekly-email-bison-report",
  // Every day at 09:00 UTC = 3:00 PM Bangladesh time (Asia/Dhaka, UTC+6, no DST)
  // Reports on the previous full UTC day
  cron: "0 9 * * *",
  run: async (payload) => {
    // ── Reporting day = yesterday (UTC) ───────────────────────────────────────
    // payload.timestamp is the scheduled fire time (today 09:00 UTC)
    const now = new Date(payload.timestamp);
    const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const date = new Date(todayMidnight - DAY_MS).toISOString().split("T")[0]; // e.g. 2026-11-17

    logger.info("Starting daily campaign report", { date });

    // ── Fetch campaigns ───────────────────────────────────────────────────────
    const fetchResult = await fetchCampaignsTask.triggerAndWait({ date });

    if (!fetchResult.ok) {
      throw new Error(`fetch-campaigns task failed: ${fetchResult.error}`);
    }

    const reportPayload = fetchResult.output;

    logger.info("Campaigns fetched", { total: reportPayload.campaigns.length });

    // ── Write to Google Sheets ────────────────────────────────────────────────
    // idempotencyKey prevents duplicate rows if this run is retried on the same day
    const writeResult = await writeReportTask.triggerAndWait(reportPayload, {
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
