# Email Bison Weekly Report — Project Notes

## What This Does

Every Monday at 9am UTC, a Trigger.dev scheduled task:
1. Fetches all active campaigns from Email Bison (plus any completed/paused/archived campaigns that were updated during the week)
2. Pulls weekly stats for each campaign via the `/line-area-chart-stats?start_date=X&end_date=Y` endpoint
3. Appends one row per campaign to the "Campaign Details" tab in Google Sheets

The reporting window is **last Monday 00:00 UTC → last Sunday 23:59 UTC**, matching the Email Bison dashboard's Mon–Sun week.

---

## Files That Matter

```
src/trigger/weekly-campaign-report/
  weekly-report.ts      — orchestrator, owns the cron schedule and date window
  fetch-campaigns.ts    — fetches all campaigns + weekly stats from Email Bison API
  write-report.ts       — writes rows to Google Sheets

run-report-now.mjs      — standalone local script to manually run any week
trigger.config.ts       — Trigger.dev project config (maxDuration, retries)
```

---

## Google Sheet Structure

**Tab:** Campaign Details

| Col | Header | Source |
|-----|--------|--------|
| A | Week Start | Date string e.g. `2026-03-30` |
| B | Campaign Name | Email Bison campaign name |
| C | Platform | Blank — add your own formula here |
| D | Status | active / completed / paused / archived |
| E | Sent | API label: "Sent" |
| F | Unique Opens | API label: "Unique Opens" — **always 0, API doesn't return this** |
| G | Replied | API label: "Replied" |
| H | Reply Rate | Computed: Replied ÷ Sent |
| I | Bounced | API label: "Bounced" |
| J | Bounce Rate | Computed: Bounced ÷ Sent |
| K | Interested | API label: "Interested" |
| L | Unsubscribed | API label: "Unsubscribed" |

**Important:** Row 1 headers are automatically repaired on every run. If headers ever look wrong, just re-run the script — it fixes itself.

---

## How the Dedup Works

A row is only skipped if **both** the Week Start date AND the Campaign Name already exist in the sheet. This means:
- Same campaign, new week → new row (correct)
- Re-running the same week → duplicates skipped (safe)
- New campaign added mid-week → written on next re-run (correct)

---

## Known Quirks

- **Unique Opens is always 0.** The Email Bison API returns 0 for both "Unique Opens" and "Total Opens" from the stats endpoint. Column F will always be empty. Consider removing it or replacing with something else if the API ever changes.

- **Replies can appear on campaigns with sent=0.** This is normal — people reply late (days after the email was sent). The stats endpoint captures replies by the date they came in, not when the email was sent.

- **Small dashboard discrepancies are expected.** Our numbers may be off by 1–5 vs the Email Bison dashboard because:
  - Dashboard shows live data (up to today), our report cuts off at Sunday midnight
  - Auto-replies are counted differently for "Replied"

- **Rate columns stored as text strings** (e.g. `"1.3%"`). This is intentional — storing as a percentage number would show as `0` in Google Sheets without explicit column formatting. If you connect Looker Studio, treat these columns as text dimensions, not metrics. To use them as numbers, add a calculated field in Looker: `REGEXP_EXTRACT(Reply_Rate, "([0-9.]+)") * 1`.

- **Week Start stored as text** (apostrophe-prefixed). Same reason — Sheets was converting `2026-03-30` into a date serial number. It's stored as plain text so it stays readable.

---

## Running It Manually

To backfill any week locally:
```bash
cd "path/to/Email Bison"
node run-report-now.mjs 2026-03-30 2026-04-05
```

No arguments = auto-detects last week:
```bash
node run-report-now.mjs
```

---

## Campaign Inclusion Logic

| Status | Included? |
|--------|-----------|
| active | Always |
| completed | Only if `updated_at` falls within the week |
| paused | Only if `updated_at` falls within the week |
| archived | Only if `updated_at` falls within the week |
| draft | Never |

---

## Environment Variables

These must be set in **both** your local `.env` and the **Trigger.dev dashboard** (production environment):

| Variable | Where to get it |
|----------|----------------|
| `EMAIL_BISON_API_KEY` | Email Bison → Settings → Developer API |
| `EMAIL_BISON_INSTANCE_URL` | Your instance URL e.g. `https://outreach.nextus.ai` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Base64-encoded service account JSON key |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | From the spreadsheet URL |
| `TRIGGER_SECRET_KEY` | Trigger.dev dashboard → API Keys (dev key for local only) |

To base64-encode the service account JSON (if you ever need to rotate the key):
```bash
node -e "console.log(Buffer.from(require('fs').readFileSync('key.json','utf-8')).toString('base64'))"
```

---

## Things to Watch as You Scale

1. **maxDuration (currently 300s):** Each active campaign requires one API call (sequential). At 56 campaigns it takes ~60s total. If active campaigns grow past ~200, increase `maxDuration` in `trigger.config.ts` to 600.

2. **Column F (Unique Opens):** Currently always 0. Worth checking again in a few months — the Email Bison API may start returning this data.

3. **Platform column (C):** Left blank intentionally for sheet formulas. If you want the code to fill it automatically, the campaign name prefix is the key:
   - `CI` → Cheap Inboxes (Google Workspace)
   - `IN`, `INB` → Inboxing (Microsoft Outlook)
   - `CS` → Custom SMTP

4. **Looker Studio connection:** The sheet appends weekly — each Monday a new set of rows is added with a new Week Start date. This makes it a clean time-series for Looker. Week Start (col A) is your date dimension. Be aware that rate columns (H, J) are text strings — use calculated fields to convert them to numbers in Looker.

---

## Deployment

GitHub is connected to Trigger.dev. **Every push to `main` auto-deploys.** No manual deploy step needed.

To check deploy status: Trigger.dev dashboard → Deployments tab.

---

## If Something Goes Wrong

**Duplicate rows in the sheet:** The dedup will prevent it going forward, but if you find duplicates from a manual re-run, delete the duplicates manually and re-run — it will skip what already exists.

**Wrong headers in the sheet:** Just re-run the script. Headers are repaired automatically on every run.

**Task fails in Trigger.dev:** Check the run logs in the Trigger.dev dashboard. The most common causes are:
- Expired API key (EMAIL_BISON_API_KEY)
- Service account lost access to the spreadsheet
- Email Bison API returning 5xx errors (auto-retries 3 times)

**Sheet accidentally deleted:** Re-run the script. It recreates the tab and re-fetches the week's data. Historical weeks will need to be backfilled manually using `run-report-now.mjs` with specific date args.
