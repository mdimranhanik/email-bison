# Prompt: switch an Email Bison report from weekly to daily

Paste everything below the line into a new chat opened in the workspace's repo.

---

This repo has a Trigger.dev task that pulls Email Bison campaign stats and writes them to Google Sheets **once a week**. I want it switched to **daily**, the same way it was already done for another workspace. Follow the process below. Ask me before anything that needs my decision, and confirm with me before you push to `main` (pushing deploys to production).

## The target

- **Spreadsheet:** "Bison Report- Daily", ID `19EcD68jl_vBELJABXJsw1lftazVzgOqPGaLbLzPhQeI`
  (https://docs.google.com/spreadsheets/d/19EcD68jl_vBELJABXJsw1lftazVzgOqPGaLbLzPhQeI/edit)
- **Tab:** ask me which tab belongs to this workspace. Don't guess, and don't create a new tab unless I say so.
- The old weekly data stays where it is, in the old spreadsheet. Don't touch it.

## The rules I decided on

1. **Schedule:** Tuesday to Saturday at **3 PM Bangladesh time**. Bangladesh is UTC+6 with no daylight saving, so that's 09:00 UTC: cron `0 9 * * 2-6`. If this repo runs several projects that share an API or the sheet, ask me whether to stagger them (e.g. 09:00, 09:15, …).
2. **Each run reports the previous UTC day.** Tuesday's run reports Monday, and Saturday's run reports Friday.
3. **Weekends are folded into Monday.** Replies do arrive on Saturday and Sunday, so Monday's row covers stats from **Saturday through Monday** and is labelled with Monday's date. Saturday and Sunday never get rows of their own.
4. **Late replies:** active campaigns are always included. Completed, paused and archived campaigns are included if their `updated_at` falls within the **7 days** up to the reporting day. Skip their row on days when every number is 0. Active campaigns are written even with all zeros.
5. **Column A is "Date"** (not "Week Start").

## Process

### 1. Understand before changing anything
- Read `PROJECT-NOTES.md` / `CLAUDE.md` if present, `trigger.config.ts`, and every file in the report task folder (orchestrator, fetch task, write task) plus any local "run now" script.
- Find out **where the cron and config live**: hard-coded in code, or in env vars such as `CRON_SCHEDULE`, `TAB_NAME`, `CLIENT_NAME` or `GOOGLE_SHEETS_SPREADSHEET_ID`. If they're env vars, the change has to be made in the Trigger.dev dashboard too. Tell me exactly which variable to set to which value, in which project and environment (production).
- Check `.env` to see which Email Bison workspace the local API key belongs to. Only that workspace can be tested locally. Don't print secret values.

### 2. Inspect the sheet tab (read-only first)
Use the service account from `GOOGLE_SERVICE_ACCOUNT_JSON` with the `spreadsheets.readonly` scope:
- List the tabs and read the target tab's header row and existing rows.
- Read row 2 with `valueRenderOption: "FORMULA"` to see whether there are sheet formulas (e.g. ARRAYFORMULAs in C2 or N2).
- If the header layout differs from the column layout below, ask me before overwriting row 1.

**Access:** the daily spreadsheet is a copy of the old one, and **copies don't inherit sharing**. Reading may work while writing fails with `403 PERMISSION_DENIED`. If so, ask me to share the spreadsheet with the service account's `client_email` as **Editor**.

### 3. Code changes

**Orchestrator (scheduled task):**
- Keep the **task id unchanged**, so Trigger.dev keeps the same schedule and run history.
- Set the cron to `0 9 * * 2-6`, or the agreed slot, through the env var if that's how this repo does it.
- Reporting day = the previous UTC day:
  ```ts
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date(payload.timestamp);
  const todayMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const date = new Date(todayMidnight - DAY_MS).toISOString().split("T")[0];
  ```
- Pass `{ date }` to the fetch task. Use idempotency key `daily-report-${date}` on the write task.

**Fetch task:**
- Stats come from `GET /api/campaigns/{id}/line-area-chart-stats?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`, summing each series (`Sent`, `Unique Opens`, `Replied`, `Bounced`, `Interested`, `Unsubscribed`). Setting `start_date` and `end_date` to the same day returns exactly one day.
- Monday covers the weekend:
  ```ts
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  const lookbackStart = new Date(dayStart.getTime() - (7 - 1) * DAY_MS);
  const statsFrom = dayStart.getUTCDay() === 1
    ? new Date(dayStart.getTime() - 2 * DAY_MS).toISOString().split("T")[0]
    : date;
  // stats: start_date=statsFrom, end_date=date
  ```
- Inclusion: `active` → always. `completed` / `paused` / `archived` → only if `lookbackStart <= updated_at <= dayEnd`, and skip if all metrics are 0. Anything else (draft) → skip.
- Return `{ date, campaigns }`.

**Write task:**
- Spreadsheet ID: `process.env.GOOGLE_SHEETS_DAILY_SPREADSHEET_ID || "19EcD68jl_vBELJABXJsw1lftazVzgOqPGaLbLzPhQeI"`. This way the old `GOOGLE_SHEETS_SPREADSHEET_ID` doesn't need changing and can't accidentally point the daily data at the old sheet.
- Tab: the one I confirm (or the repo's `TAB_NAME` env var if it already uses one). **Quote the tab name in A1 notation:** `'${tab}'!A:B`. Names with spaces or hyphens fail unquoted.
- Column layout (row 1 is rewritten every run to self-heal):

  | Col | Header | Value |
  |---|---|---|
  | A | Date | `'YYYY-MM-DD` (apostrophe keeps it as text) |
  | B | Campaign Name | |
  | C | Platform | computed in code, see below |
  | D | Status | |
  | E | Sent | |
  | F | Unique Opens | always 0 from the API, known limitation |
  | G | Replied | |
  | H | Reply Rate | `'x.x%` text, or `N/A` if Sent = 0 |
  | I | Bounced | |
  | J | Bounce Rate | `'x.x%` text, or `N/A` |
  | K | Interested | |
  | L | Unsubscribed | |
  | M | Client | `CLIENT_NAME` env var |
  | N | Aged Status | computed in code, see below |

- **Compute Platform and Aged Status in code. Don't rely on sheet ARRAYFORMULAs:** when the script writes rows into those columns, the formulas break with `#REF!`. Use the same rules the old sheet formulas used:
  ```ts
  function platformFor(name: string): string {
    if (/\bSMTP\b/i.test(name)) return "Custom SMTP";
    if (/\bIN\b/i.test(name)) return "inboxing";
    if (/\bCI\b/i.test(name)) return "cheapinboxes";
    return "";
  }
  function agedStatusFor(name: string): string {
    return /\(ag/i.test(name) ? "AGED" : "not aged";
  }
  ```
- Dedup: read `A:B` and skip any row whose `Date|Campaign Name` already exists (strip the leading apostrophe when comparing). Append with `valueInputOption: "USER_ENTERED"`, `insertDataOption: "INSERT_ROWS"`, range `'${tab}'!A:N`.

**Local "run now" script (if the repo has one):** bring it in line with the same logic. It should accept no args (yesterday), one date, or a `start end` range that loops day by day. When looping, skip Saturday and Sunday and apply the Monday Sat→Mon window.

### 4. Test before deploying
1. `npx tsc --noEmit -p .` must pass, and `node --check` must pass on any `.mjs` script.
2. **Check the regexes are intact:** on Windows, shell heredocs, `python -c` and `node -e` can turn `\b` into a literal backspace character. Write code with the file editor tool. Then confirm with `grep -c $'\x08' <files>` (must be 0) and test `platformFor` on sample names: `SMTP(C)` → Custom SMTP, ` IN ` → inboxing, `CI,` → cheapinboxes, `INTERNAL` → "".
3. With my OK, backfill **yesterday** into the tab using the local script (only possible for the workspace whose API key is in `.env`). Read the tab back and check that the rows landed starting at row 2, that Platform and Aged Status are filled with no `#REF!`, that Client is set, and that the totals look sane.
4. Run the same day again and confirm every row is skipped as a duplicate.
5. If a test write goes wrong, only clear rows you wrote yourself. Check that every row you're about to clear has the test date before clearing.

### 5. Deploy
- Commit with a clear message and **ask me before pushing to `main`**. Pushing auto-deploys to Trigger.dev.
- Then tell me to check two things in the Trigger.dev dashboard: (a) **Deployments**: the new commit finished deploying; (b) **Schedules**: the task shows the new cron and the next run time. Also list any env vars I need to set or change there (e.g. `CRON_SCHEDULE`, `CLIENT_NAME`, `GOOGLE_SHEETS_DAILY_SPREADSHEET_ID`).
- Expect this: if you backfilled yesterday, the first scheduled run reports that same day and writes **0 rows**, because the rows are already there. That's correct.

### 6. Report back
Summarize in plain language: what changed, which tab and rows were written, the schedule in Bangladesh time, what I still need to do in the dashboard, and anything you couldn't verify.
