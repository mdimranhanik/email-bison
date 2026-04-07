import { schedules, logger } from "@trigger.dev/sdk/v3";
import { fetchCampaignsTask } from "./fetch-campaigns.js";
import { writeReportTask } from "./write-report.js";

export const weeklyReportTask = schedules.task({
  id: "weekly-email-bison-report",
  // Every Monday at 9:00 AM UTC
  cron: "0 9 * * 1",
  run: async (payload) => {
    // ── Compute the Mon→Mon reporting window ──────────────────────────────────
    // payload.timestamp is the scheduled fire time (this Monday 9:00 AM UTC)
    // weekEnd   = this Monday 00:00 UTC
    // weekStart = last Monday 00:00 UTC (7 days prior)
    const now = new Date(payload.timestamp);
    const weekEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    const weekStartISO = weekStart.toISOString();
    const weekEndISO = weekEnd.toISOString();

    logger.info("Starting weekly campaign report", { weekStartISO, weekEndISO });

    // ── Fetch campaigns ───────────────────────────────────────────────────────
    const fetchResult = await fetchCampaignsTask.triggerAndWait({
      weekStart: weekStartISO,
      weekEnd: weekEndISO,
    });

    if (!fetchResult.ok) {
      throw new Error(`fetch-campaigns task failed: ${fetchResult.error}`);
    }

    const reportPayload = fetchResult.output;

    logger.info("Campaigns fetched", { total: reportPayload.campaigns.length });

    // ── Write to Google Sheets ────────────────────────────────────────────────
    // idempotencyKey prevents duplicate rows if this run is retried on the same Monday
    const writeResult = await writeReportTask.triggerAndWait(reportPayload, {
      idempotencyKey: `weekly-report-${weekStartISO}`,
    });

    if (!writeResult.ok) {
      throw new Error(`write-report task failed: ${writeResult.error}`);
    }

    const { rowsWritten } = writeResult.output;

    logger.info("Weekly report complete", {
      weekStart: weekStartISO,
      weekEnd: weekEndISO,
      campaignsReported: reportPayload.campaigns.length,
      rowsWrittenToSheets: rowsWritten,
    });

    return {
      weekStart: weekStartISO,
      weekEnd: weekEndISO,
      campaignsReported: reportPayload.campaigns.length,
      rowsWrittenToSheets: rowsWritten,
    };
  },
});
