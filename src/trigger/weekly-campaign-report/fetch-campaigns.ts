import { task, logger } from "@trigger.dev/sdk/v3";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EBTag {
  id: number;
  name: string;
}

export interface EBCampaign {
  id: number;
  name: string;
  status: string;
  total_leads_contacted: number;
  created_at: string;
  updated_at: string;
  tags: EBTag[];
}

export interface EBListResponse {
  data: EBCampaign[];
  links: { next: string | null };
  meta?: { current_page: number; last_page: number; total: number };
}

// Daily stats from /line-area-chart-stats endpoint
// Each entry: { label: "Sent", dates: [["2026-04-01", 120], ...] }
interface EBStatSeries {
  label: string;
  dates: [string, number][];
}

export interface CampaignMetrics {
  sent: number;
  uniqueOpens: number;
  replied: number;
  bounced: number;
  interested: number;
  unsubscribed: number;
  leadsContacted: number;
}

export interface ProcessedCampaign {
  id: number;
  name: string;
  status: string;
  platform: string;
  metrics: CampaignMetrics;
}

export interface ReportPayload {
  date: string; // reporting day, YYYY-MM-DD (UTC)
  campaigns: ProcessedCampaign[];
}

// Non-active campaigns (completed/paused/archived) are included if they were
// updated within this many days up to the reporting day — so late replies on a
// recently finished campaign are still counted on the day they arrive.
const LOOKBACK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  const instanceUrl =
    process.env.EMAIL_BISON_INSTANCE_URL ?? "https://dedi.emailbison.com";
  return `${instanceUrl.replace(/\/$/, "")}/api`;
}

async function apiFetch(url: string, apiKey: string): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (res.ok) return res;
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10", 10);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    lastError = new Error(`Email Bison API ${res.status} — ${url}`);
  }
  throw lastError ?? new Error(`Email Bison API failed after 3 attempts: ${url}`);
}

// Sum all daily values in a series across the date range
function sumSeries(series: EBStatSeries[], label: string): number {
  const s = series.find((s) => s.label.toLowerCase() === label.toLowerCase());
  if (!s) return 0;
  return s.dates.reduce((acc, [, val]) => acc + (val ?? 0), 0);
}

// Fetch stats for a single campaign using the date-filtered endpoint
async function fetchStats(
  BASE_URL: string,
  apiKey: string,
  campaignId: number,
  startDate: string,
  endDate: string
): Promise<CampaignMetrics> {
  try {
    const url = `${BASE_URL}/campaigns/${campaignId}/line-area-chart-stats?start_date=${startDate}&end_date=${endDate}`;
    const res = await apiFetch(url, apiKey);
    const body = (await res.json()) as { data: EBStatSeries[] };
    const series = body.data ?? [];

    return {
      sent: sumSeries(series, "Sent"),
      uniqueOpens: sumSeries(series, "Unique Opens"),
      replied: sumSeries(series, "Replied"),
      bounced: sumSeries(series, "Bounced"),
      interested: sumSeries(series, "Interested"),
      unsubscribed: sumSeries(series, "Unsubscribed"),
      leadsContacted: 0, // not available from this endpoint
    };
  } catch {
    logger.warn(`Could not fetch stats for campaign ${campaignId}, using zeros`);
    return { sent: 0, uniqueOpens: 0, replied: 0, bounced: 0, interested: 0, unsubscribed: 0, leadsContacted: 0 };
  }
}

// ─── Task ─────────────────────────────────────────────────────────────────────

export const fetchCampaignsTask = task({
  id: "fetch-email-bison-campaigns",
  run: async (payload: { date: string }): Promise<ReportPayload> => {
    const apiKey = process.env.EMAIL_BISON_API_KEY;
    if (!apiKey) throw new Error("EMAIL_BISON_API_KEY is not set");

    const BASE_URL = getBaseUrl();
    const { date } = payload; // YYYY-MM-DD
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    const lookbackStart = new Date(dayStart.getTime() - (LOOKBACK_DAYS - 1) * DAY_MS);
    // Weekends are not reported on their own: Monday's row also covers Saturday + Sunday
    const statsFrom =
      dayStart.getUTCDay() === 1
        ? new Date(dayStart.getTime() - 2 * DAY_MS).toISOString().split("T")[0]
        : date;

    logger.info("Fetching campaigns", {
      date,
      statsFrom,
      lookbackStart: lookbackStart.toISOString(),
    });

    // ── Step 1: Paginate all campaigns ────────────────────────────────────────
    const allCampaigns: EBCampaign[] = [];
    let page = 1;
    const MAX_PAGES = 500;

    while (page <= MAX_PAGES) {
      const body = (await (await apiFetch(`${BASE_URL}/campaigns?page=${page}`, apiKey)).json()) as EBListResponse;
      if (!body.data || body.data.length === 0) break;
      allCampaigns.push(...body.data);
      if (!body.links?.next) break;
      page++;
    }

    logger.info(`Fetched ${allCampaigns.length} campaigns across ${page} page(s)`);

    // ── Step 2: Filter to relevant campaigns ─────────────────────────────────
    // - "active"                              → always include
    // - "completed"/"paused"/"archived"       → only if updated in the last LOOKBACK_DAYS
    // - "draft" and anything else             → skip
    const seenIds = new Set<number>();
    const relevantCampaigns: EBCampaign[] = [];

    for (const c of allCampaigns) {
      if (seenIds.has(c.id)) continue;

      if (c.status === "active") {
        // always relevant
      } else if (c.status === "completed" || c.status === "paused" || c.status === "archived") {
        const updated = new Date(c.updated_at);
        if (updated < lookbackStart || updated > dayEnd) continue;
      } else {
        continue;
      }

      seenIds.add(c.id);
      relevantCampaigns.push(c);
    }

    logger.info(`${relevantCampaigns.length} campaigns relevant to ${date} — fetching stats ${statsFrom} → ${date}`);

    // ── Step 3: Fetch stats for the reporting day per campaign (sequentially) ─
    const campaigns: ProcessedCampaign[] = [];
    let skippedEmpty = 0;

    for (const c of relevantCampaigns) {
      const metrics = await fetchStats(BASE_URL, apiKey, c.id, statsFrom, date);
      // Non-active campaigns are only pulled in by the lookback — skip them on
      // days with no activity so the sheet isn't filled with all-zero rows.
      const hasActivity =
        metrics.sent + metrics.uniqueOpens + metrics.replied + metrics.bounced +
          metrics.interested + metrics.unsubscribed > 0;
      if (c.status !== "active" && !hasActivity) {
        skippedEmpty++;
        continue;
      }
      campaigns.push({
        id: c.id,
        name: c.name,
        status: c.status,
        platform: "",
        metrics,
      });
    }

    logger.info(`Daily stats fetched for ${campaigns.length} campaigns`, {
      skippedInactiveWithNoActivity: skippedEmpty,
    });

    return { date, campaigns };
  },
});
