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
    // Cron fires Monday 9am UTC
    // weekEnd   = this Monday 00:00 UTC (exclusive, = yesterday Sunday 23:59)
    // weekStart = last Monday 00:00 UTC
    // This gives Mon 00:00 → Sun 23:59 — matching Email Bison dashboard (Mon→Sun)
    const thisMonday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const weekStart = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000); // last Monday
    const weekEnd = new Date(thisMonday.getTime() - 1); // Sunday 23:59:59.999 UTC

    const weekStartISO = weekStart.toISOString(); // e.g. 2026-03-30T00:00:00.000Z
    const weekEndISO = weekEnd.toISOString();     // e.g. 2026-04-05T23:59:59.999Z

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
