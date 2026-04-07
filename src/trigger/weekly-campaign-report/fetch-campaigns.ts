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
  emails_sent: number;
  unique_opens: number;
  unique_replies: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
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

export type Platform = string; // derived from campaign name, can be refined via sheet formulas

export interface CampaignMetrics {
  sent: number;
  uniqueOpens: number;
  uniqueReplies: number;
  bounced: number;
  interested: number;
  unsubscribed: number;
  leadsContacted: number;
}

export interface ProcessedCampaign {
  id: number;
  name: string;
  status: string;
  platform: Platform;
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


function extractMetrics(c: EBCampaign): CampaignMetrics {
  return {
    sent: c.emails_sent ?? 0,
    uniqueOpens: c.unique_opens ?? 0,
    uniqueReplies: c.unique_replies ?? 0,
    bounced: c.bounced ?? 0,
    interested: c.interested ?? 0,
    unsubscribed: c.unsubscribed ?? 0,
    leadsContacted: c.total_leads_contacted ?? 0,
  };
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

    logger.info("Fetching campaigns", { weekStart, weekEnd });

    // ── Paginate all campaigns ────────────────────────────────────────────────
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

    // ── Filter campaigns relevant to this week (deduped by campaign id) ─────────
    // - "active"             → always include (currently running)
    // - "completed"/"paused" → include only if updated_at is within the week window
    // - everything else      → skip (draft, archived)
    const seenIds = new Set<number>();
    const campaigns: ProcessedCampaign[] = [];

    for (const c of allCampaigns) {
      if (seenIds.has(c.id)) continue; // dedup

      if (c.status === "active") {
        // live right now — always relevant
      } else if (c.status === "completed" || c.status === "paused" || c.status === "archived") {
        const updated = new Date(c.updated_at);
        if (updated < weekStartDate || updated >= weekEndDate) continue;
      } else {
        continue; // draft and anything else
      }

      seenIds.add(c.id);
      campaigns.push({
        id: c.id,
        name: c.name,
        status: c.status,
        platform: "",
        metrics: extractMetrics(c),
      });
    }

    logger.info(`${campaigns.length} active campaigns in reporting window`);

    return { weekStart, weekEnd, campaigns };
  },
});
