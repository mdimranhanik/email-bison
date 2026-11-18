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
  weekStart: string;
  weekEnd: string;
  campaigns: ProcessedCampaign[];
}

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

function toDateStr(iso: string): string {
  return iso.split("T")[0]; // "2026-03-30T00:00:00.000Z" → "2026-03-30"
}

// Sum all daily values in a series across the date range
function sumSeries(series: EBStatSeries[], label: string): number {
  const s = series.find((s) => s.label.toLowerCase() === label.toLowerCase());
  if (!s) return 0;
  return s.dates.reduce((acc, [, val]) => acc + (val ?? 0), 0);
}

// Fetch weekly stats for a single campaign using the date-filtered endpoint
async function fetchWeeklyStats(
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
    logger.warn(`Could not fetch weekly stats for campaign ${campaignId}, using zeros`);
    return { sent: 0, uniqueOpens: 0, replied: 0, bounced: 0, interested: 0, unsubscribed: 0, leadsContacted: 0 };
  }
}

// ─── Task ─────────────────────────────────────────────────────────────────────

export const fetchCampaignsTask = task({
  id: "fetch-email-bison-campaigns",
  run: async (payload: { weekStart: string; weekEnd: string }): Promise<ReportPayload> => {
    const apiKey = process.env.EMAIL_BISON_API_KEY;
    if (!apiKey) throw new Error("EMAIL_BISON_API_KEY is not set");

    const BASE_URL = getBaseUrl();
    const { weekStart, weekEnd } = payload;
    const weekStartDate = new Date(weekStart);
    const weekEndDate = new Date(weekEnd);

    // Date strings for the stats endpoint (YYYY-MM-DD)
    const startDate = toDateStr(weekStart);
    const endDate = toDateStr(weekEnd);

    logger.info("Fetching campaigns", { weekStart, weekEnd });

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
    // - "completed"/"paused"/"archived"       → only if updated this week
    // - "draft" and anything else             → skip
    const seenIds = new Set<number>();
    const relevantCampaigns: EBCampaign[] = [];

    for (const c of allCampaigns) {
      if (seenIds.has(c.id)) continue;

      if (c.status === "active") {
        // always relevant
      } else if (c.status === "completed" || c.status === "paused" || c.status === "archived") {
        const updated = new Date(c.updated_at);
        if (updated < weekStartDate || updated >= weekEndDate) continue;
      } else {
        continue;
      }

      seenIds.add(c.id);
      relevantCampaigns.push(c);
    }

    logger.info(`${relevantCampaigns.length} campaigns relevant to this week — fetching weekly stats`);

    // ── Step 3: Fetch actual weekly stats per campaign (sequentially) ─────────
    const campaigns: ProcessedCampaign[] = [];

    for (const c of relevantCampaigns) {
      const metrics = await fetchWeeklyStats(BASE_URL, apiKey, c.id, startDate, endDate);
      campaigns.push({
        id: c.id,
        name: c.name,
        status: c.status,
        platform: "",
        metrics,
      });
    }

    logger.info(`Weekly stats fetched for ${campaigns.length} campaigns`);

    return { weekStart, weekEnd, campaigns };
  },
});
