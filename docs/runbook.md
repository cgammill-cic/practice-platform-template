# Runbook — practice-platform

## How deployment works

Connect Cloudflare Workers Builds to your GitHub repository (Cloudflare dashboard → Workers & Pages →
your Worker → Settings → Build → connect a repository).

- Merge/push to `main` → automatic production deploy to your Worker's `*.workers.dev` URL (or your custom
  domain, if you've set one up).
- Open a pull request → automatic preview deploy at a separate preview URL (posted on the PR by Cloudflare).

No manual deploy step is needed day to day. Manual fallback: `npx wrangler deploy` from a machine logged
in via `npx wrangler login`.

## Rollback

Dashboard route (fastest): Cloudflare dashboard → Workers & Pages → your Worker → **Deployments** tab →
Version History → open the ⋯ menu on the last known-good version → **Promote version** → confirm.
("Promote" is Cloudflare's name for making any prior version live — rolling back and rolling forward are
both a promote.)

Git route (durable): `git revert <bad commit>` on `main` (or GitHub → commit → Revert) → the revert
commit auto-deploys. Prefer this when the bad change must not resurface on the next merge.

Test both rollback routes once, deliberately, before you need them for real — verify the dashboard
promote and a git revert both actually restore the previous behavior, on a low-stakes change.

## Database migrations

Migrations live in `/migrations`, numbered sequentially (`0001_...sql`). Each file's own header should
document its rollback.

- **Apply the migration BEFORE the PR that depends on it is merged**, whenever the new code reads a
  column or table the migration adds. A merge to `main` auto-deploys, so an unapplied migration breaks
  production the moment the PR lands. Whoever prepares the PR applies the migration first and says so on
  the PR — the Cloudflare Workers Builds token cannot apply D1 migrations itself; it covers the Worker
  deploy, not the database.
- Applying a migration: `npx wrangler d1 execute <your-db-name> --remote --file=migrations/00NN_whatever.sql`,
  against dev first, smoke-test, then prod.
- If you apply a migration by hand, add its row to `d1_migrations` in the same sitting:
  `INSERT INTO d1_migrations (name) VALUES ('00NN_whatever.sql');`. A hand-applied migration missing from
  the ledger means a future `wrangler d1 migrations apply` will try to replay it — or worse, replay
  everything before it — against a database that already has it.
- **`/health` checks the schema against the migrations**, on whichever database it is talking to.
  `scripts/schema-manifest.mjs` replays `migrations/*.sql` and generates `src/schemaManifest.ts` — the
  tables, indexes and triggers that should exist. The health page compares that against `sqlite_master`:
  missing is a red Problem naming the migration to apply, extra is an amber warning. Regenerate with
  `npm run schema:manifest` after adding a migration; `npm run schema:check` fails if the committed
  manifest is stale, and `npm run check` runs it alongside the typecheck. This is the guard against a
  forgotten or half-applied hand migration — without it, the discovery route is whichever feature breaks
  first.
- **A local dev database is built with `npm run db:local`.** It deletes the local D1 state and replays
  all migrations from empty, then verifies the result against the manifest. It always rebuilds from
  empty and destroys local data — several migrations in this codebase rebuild tables via
  create-copy-drop-rename, which does not replay safely over an already-migrated database. Local data is
  disposable; production migrations are still applied by hand, deliberately.
- Never apply an untested migration to prod. Take a manual backup first (dashboard button, or
  `POST /admin/backup`).

## Backups

**Schedule:** nightly (see the cron trigger in `wrangler.jsonc`) → full JSON export of every table to the
R2 bucket bound as `BACKUPS`, under `backups/`, with a manifest at `manifest/latest.json`. Retention: 30
days.

**Manual backup:** "Run backup now" button on the dashboard (or `POST /admin/backup` while signed in).
Use before imports and migrations.

**Verification layers (all automatic, every run):**

1. Missing run → dashboard banner turns red when the last recorded backup is older than 26 hours.
2. Silent no-op → if a backup's checksum equals the previous one but `audit_event` shows writes since,
   the run is recorded as an alert ("backup not capturing changes").
3. Corruption → every backup is read back from R2 and parsed before counting as successful.

Backup state also appears in `GET /health`. There is no outbound alert channel by default beyond the
dashboard banner and the health endpoint — add one (email via your Outlook connection, or a webhook) if
you need to be notified without opening the app.

### Restore procedure

1. Cloudflare dashboard → R2 Object Storage → your backups bucket → `backups/` → pick the timestamped
   file → Download. (The file is JSON: `{ exported_at, tables: { <table>: [rows] } }`.)
2. Restore to **dev first**, never straight to production.
3. For each table, generate `INSERT INTO <table> (cols…) VALUES (…)` from the file's rows — preserving
   `id` values so foreign keys stay intact — and run against the target database. Insert parents before
   children: organization → contact → interaction / contact_tag / engagement; `audit_event` and `tag` are
   independent.
4. Verify row counts per table against the file, and spot-check content.
5. Only after dev verifies clean, repeat against production if a real recovery is underway.

**Run a restore drill before you trust this with real data** — export, delete a table's rows in dev,
restore from the export, and confirm the row count and content match.

## Secrets

Set in Cloudflare dashboard → Workers & Pages → your Worker → Settings → Variables and Secrets
(type: Secret):

| Name | Purpose |
|---|---|
| `APP_PASSWORD` | The sign-in passphrase. Known only to you; never committed, never shared in chat or elsewhere. |
| `SESSION_SECRET` | Signs session cookies **and derives the key that encrypts the stored Outlook refresh token**. Long random string; rotate to force sign-out everywhere. See the warning below. |
| `MS_CLIENT_ID` | Entra application (client) ID for your app registration, if you use the Outlook integration. Not sensitive — identifies the app, does not authenticate it. |
| `MS_TENANT_ID` | Entra directory (tenant) ID. Not sensitive; published at your tenant's own `.well-known/openid-configuration` endpoint. |
| `MS_CLIENT_SECRET` | The Entra client secret **Value** (not the Secret ID). This one is the credential. Expires — note the date, because when it lapses the calendar import stops and says only that Microsoft refused the token. |
| `MS_TIMEZONE` | Optional. Timezone assumed when Graph will not report the mailbox's own. Use a **Windows** zone id (`Eastern Standard Time`, `Central Standard Time`), not IANA (`America/New_York`) — Graph is asked in the same vocabulary `/me/mailboxSettings` answers in. Not sensitive; plain text is fine. |

All the Microsoft variables are **optional**: with none set, the app runs normally and the Outlook panel
on `/health` reports that it is not configured. Set them as type **Secret**, not plain text — secrets
survive the automatic deploy that every merge to `main` triggers.

> **Rotating `SESSION_SECRET` also disconnects Outlook.** The refresh token is encrypted at rest with a
> key derived from it, so rotating makes the stored token unreadable. This is deliberate, not a bug: a
> lost device should cost an attacker the calendar as well as the session. `/health` will say *"could not
> be decrypted… Reconnect Outlook"*, and reconnecting is one click. Do not "fix" it by moving to a static
> key.

Secrets are never committed to this repository. Rotating `SESSION_SECRET` invalidates all sessions
immediately (useful if a device is lost). Note: saving a secret creates a new deployment version — this
is normal and shows up in Version History.

## Databases (D1)

| Name (suggested) | Use |
|---|---|
| `<yourapp>-prod` | Production. Bound as `DB` in `wrangler.jsonc`. |
| `<yourapp>-dev` | Dev/testing, including restore drills. Never bound in production config. |

Create these with `wrangler d1 create <name>`, then put the IDs it prints into `wrangler.jsonc`. Local
development (`npm run dev`) uses a local SQLite simulation — it does not touch either real database.

## Stage history

`contact_stage_event` records every stage change with a date. Captured by two **database triggers** on
`contact`, not by application code — so it cannot be bypassed by a screen that forgets to call it, and it
also catches changes made by hand in the D1 console.

- `contact_stage_change` — fires on any UPDATE where the stage actually differs. An update that rewrites
  the same value records nothing.
- `contact_stage_initial` — fires on INSERT, recording a new contact's starting stage with `from_stage`
  NULL.

`origin` distinguishes `trigger` (recorded live) from `audit-backfill` (reconstructed from `audit_event`,
if you ever need to backfill history for a table created after data already existed). **A trigger cannot
know who made the change or from which screen**, so `actor` and `source` are deliberately absent — the
audit trail answers that. Do not move capture into application code to get them back.

If you ever need to disable capture: `DROP TRIGGER contact_stage_change; DROP TRIGGER contact_stage_initial;`.
The table keeps whatever it already holds.

## Health check

`GET /health` (requires sign-in) returns a page (and `GET /health.json` the same information as JSON) —
database reachability, backup status, vocabulary drift checks (stages, activities), the Outlook
connection, and schema completeness against the migrations.

`activities` reports whether the activity categories on `/activities` agree with what's actually in the
time-entry data — see `src/vocabulary.ts` for what each state means.

`outlook` reports `configured`, `connected` and the last error. It deliberately does **not** include which
account is connected — a monitor needs to know whether the link is alive, not whose mailbox it is.

## Setting up Outlook for the first time

Skip this whole section if you don't use Outlook, or want to add it later — the app runs fully without it,
and `/health` will just say the Outlook connection isn't configured.

Connecting Outlook needs an app registration in Microsoft Entra (Microsoft's name for what used to be
called Azure AD) — a small, free, one-time setup that gives your deployment permission to read your own
calendar and mail. This only needs doing once per deployment, by whoever's mailbox is being connected.

1. Go to <https://entra.microsoft.com> and sign in with the same Microsoft account whose calendar you want
   to connect (a personal Microsoft 365 account works fine — you don't need to be part of an organization).
2. **App registrations** (left sidebar, under Identity) → **New registration**.
3. Name it anything — "Practice Platform" is fine. Under **Supported account types**, choose "Accounts in
   this organizational directory only" (the single-tenant option) unless you specifically need otherwise.
4. Under **Redirect URI**, choose platform **Web** and enter:
   ```
   https://<your-worker-url>/auth/microsoft/callback
   ```
   using your actual deployment's URL (the one from the Domains tab in the Cloudflare dashboard, or the
   `APP_URL` you set during deploy) — for example
   `https://practice-platform.your-subdomain.workers.dev/auth/microsoft/callback`.
5. Click **Register**. On the app's Overview page, copy two values:
   - **Application (client) ID** → this is `MS_CLIENT_ID`
   - **Directory (tenant) ID** → this is `MS_TENANT_ID`
6. **Certificates & secrets** (left sidebar) → **New client secret** → give it any description, pick an
   expiry (24 months is reasonable) → **Add**. Immediately copy the **Value** column (not the Secret ID) —
   this is `MS_CLIENT_SECRET`, and Microsoft only shows it once. Note the expiry date somewhere; when it
   lapses, the calendar import stops and the fix is a new secret here.
7. **API permissions** (left sidebar) → **Add a permission** → **Microsoft Graph** → **Delegated
   permissions** → add all of: `User.Read`, `Calendars.Read`, `Mail.ReadBasic`, `Mail.Send`,
   `offline_access` (this last one may already be listed by default). If you see a **Grant admin consent**
   button and you're the only person in your tenant, click it — this saves the consent prompt on first
   sign-in. If you don't see it or aren't sure, skip it; you'll be prompted to consent when you connect.
8. Put the three values into your deployment:
   - Locally, add them to `.dev.vars` (see "Setup, once" in `docs/local-setup.md`).
   - In production, go to your Worker in the Cloudflare dashboard → **Settings → Variables and Secrets** →
     add `MS_CLIENT_ID`, `MS_TENANT_ID` and `MS_CLIENT_SECRET` as **secrets**, then redeploy (or just save —
     Workers picks up new secret values on the next request for most changes; a fresh deploy guarantees it).
9. Continue to **Connecting**, below.

## Outlook calendar connection

**Connecting:** `/health` → Outlook Calendar panel → **Connect Outlook**. Sign in once; the app stores a
refresh token and stays connected.

**What it can do:** read your calendar, read email metadata (senders, recipients, subjects and dates —
never message bodies), read your own profile, and **send mail as you** (used only for the daily digest,
and only ever to your own address). Nothing in this app alters your calendar or your existing mail. The
scopes granted are shown on the panel.

**When it breaks,** the panel and the `Outlook connection` check both turn red and name the cause.
Reconnecting is the fix for nearly all of them:

| Symptom | Cause | Fix |
|---|---|---|
| "could not be decrypted" | `SESSION_SECRET` was rotated | Connect Outlook again |
| "Microsoft rejected the stored token (invalid_grant)" | Password changed, signed out everywhere, or consent revoked. Permanent — retrying cannot work | Connect Outlook again |
| "Graph refused the request" | Token is valid but the permission is not there | Check the API permissions on the app registration |
| "credentials are not configured" | One of the three secrets is missing | Set it in Cloudflare |
| Silent failure after months | The client secret expired | New secret in Entra, update `MS_CLIENT_SECRET` |

**Running an import:** `/time` → *import from Outlook*, or `/time/import?week=YYYY-MM-DD`. Pick a week,
review the proposed rows, adjust anything, tick what you want and press Import. Nothing is written until
then. Rows are grouped by day, and each day heading shows hours ticked against hours on the calendar — the
two differ, and the gap is that day's unresolved time. Re-running the same week updates the entries that
import created and leaves hand-typed rows alone.

**When a client category does not match a customer.** The import matches an Outlook client category
against the customer's **Outlook Category** field, falling back to the organization name when that field
is blank. So a category matching a customer's exact name needs no setup, but a category using a
shorthand (e.g. `Acme` for `Acme Corporation, Inc.`) will not match until you open the customer on
`/engagements` and set **Outlook Category** to `Acme`. The field is saved on the organization, so all of
that client's engagements share it. If two customers end up answering to the same category the row is
flagged `two customers match` and nothing is guessed; make the categories distinct rather than picking by
hand every week.

**A customer missing from the dropdown** is almost always an engagement marked **Complete** — that is the
only status excluded. Prospective and On Hold both appear, labelled with their status, because business
development hours belong to work that is not active yet.

**Correcting an imported entry protects it.** Change the date, hours, activity or customer on a row the
import created and it is marked: the next import of that week shows it flagged `corrected`, unticked, and
leaves your version alone. Ticking it is how you take Outlook's numbers back, and that writes an audit
line saying the correction was replaced. Editing only the Comments field does not mark the row.

**Comments belong to you; subjects belong to Outlook.** Every time entry has both. The import writes the
event subject into `subject` and refreshes it on every re-import; the **Comments** box is `note`, and the
import never overwrites it — the box on the import page is prefilled with whatever you wrote last time
and hands it straight back. Leaving that box empty does not erase an existing comment; clear one on the
entry itself (`/time/<id>/edit`), where it is unambiguous. Comments on billable hours show line by line
on the weekly report, which is the copy to read when raising an invoice.

**Disconnecting** deletes the stored token so this app can no longer use it. It does **not** revoke the
consent at Microsoft — Graph has no simple call for that. To withdraw the grant entirely, remove it at
`myaccount.microsoft.com`. The panel says so rather than implying more than happened.

**A different account is refused.** If someone else signs in while a connection exists, it is rejected
rather than replacing it — reading another person's calendar into this timesheet would be silent and
wrong. Disconnect first to swap accounts.

`attempts` reports contacts whose recorded outreach the escalation ladder has not counted. It only ever
flags history running AHEAD of the ladder; the reverse (a rung whose interaction was later edited or
deleted) is deliberate and stays quiet. Recording a new attempt on an affected contact clears that row.

## Daily digest

**What it is:** one email on weekday mornings, listing meetings today, action items due, overdue
follow-ups, who you are waiting on, and meetings later in the week. It is sent from your own Outlook
account to your own address, and to no one else — there is no code path in this app that emails anybody
but the connected account.

**Turning it off and on:** `/health` → **Daily Digest** → *Turn the digest off*. It stops immediately and
stays off through deploys, reconnects and a rebuilt Outlook connection, because the setting lives in
`app_setting`, not on the connection row.

**Send one now** on the same panel sends a digest immediately, ignoring the hour and the weekday. It
still obeys the off switch and still sends nothing if nothing is due.

**No email is normal.** Nothing is sent when nothing is due — a daily "you have 0 items" is how a sender
gets filtered. So silence means one of two things, and the **Last run** line on the panel is how you tell
them apart:

| Last run says | Meaning |
|---|---|
| Sent | The email went out |
| Nothing was due, so nothing was sent | Working, quiet day |
| Skipped — switched off | The switch is off |
| Failed | Something broke; the Detail line names it |
| never run yet | The cron has not fired since this shipped, or the migration is not applied |

**If it says Failed with HTTP 403**, the Outlook connection predates the `Mail.Send` permission.
`/health` → Outlook → **Reconnect**.

**Schedule and daylight saving.** Cloudflare crons are UTC and do not move with DST — see the two cron
entries in `wrangler.jsonc` and `SEND_HOUR_LOCAL` in `src/digest.ts` for how the local-hour check works.
Changing the send time means changing both together, keeping the two cron entries an hour apart and
straddling the target. Both must also stay in `DIGEST_CRONS`, which is what routes a firing to the digest
instead of the nightly backup.

**If nothing arrives at all,** check in this order: the panel's Last run line, then that the Outlook
connection is healthy, then that `app_setting` exists in the database (`/health` → Schema — a missing
migration reads as off, on purpose).

## Pursuits

**Creating one:** `/pursuits` → **New Pursuit**, or `/engagements/new`. Same form as an engagement — a
pursuit *is* an engagement, at an earlier status. Set the status to Identified, Qualifying, Proposal in
Progress, Proposal Submitted or Verbal Yes and it appears on `/pursuits`.

**Winning one:** change the status to Active. Nothing is retyped, and any Pursuit/Proposal hours you
logged against it stay attached — which is what makes "what did winning this cost me" answerable.

**Losing one:** set the status to Lost, No Decision or Withdrawn, and set the **Outcome Reason**. The save
is not blocked if you skip the reason, but the pursuit then shows as *not recorded* on the demand report,
and the losses are the half of that report that says what is actually in demand rather than what you
happened to sell.

**Naming the people:** save the pursuit first, then use the *People on this pursuit* block on the edit
page. The name must match an active contact exactly — roles point at real records, so add the person as
a contact first if they are not one. One person can hold two roles.

**Billing methods** include *Time & Materials, Not to Exceed*, which is the only method that uses the
**Not-to-Exceed Cap** field — setting a cap with any other method is refused. *Not Decided Yet* is a real
answer on a new pursuit; use it rather than picking something to get past the field.

**Where pursuits show up:**

| Screen | What it shows |
|---|---|
| `/pursuits` | The pipeline by stage, with amounts, plus demand by service type and by origin |
| Dashboard section 8 | Only pursuits whose next step is due or whose decision date has arrived |
| The daily digest | The same list as section 8, in the morning email |
| A contact's record | The pursuits that person is named on, and in what role |
| `/engagements` | Everything, including closed and lost |

**Two things to be careful about:**

1. **A lost pursuit is a row in the customer table.** It is excluded from the time-entry customer picker,
   deliberately, so you cannot log hours against work that never existed. If a customer is missing from
   that dropdown, check whether its status is Complete, Lost, No Decision or Withdrawn — those four are
   the only ones excluded.
2. **`service_type` is a fixed list.** Adding a category is a one-line change to `SERVICE_TYPES` in
   `src/types.ts` with no migration. Do add one rather than filing work under the nearest wrong category —
   that is exactly the drift the list exists to stop, and it corrupts the demand counts.

**Adding a dashboard section** means widening the whitelist regex on the collapse cookie in
`src/index.ts`. Miss it and the new section silently can never stay collapsed — no error, it just reopens
on every render.

## Organizations

**Editing a company:** nav → **Companies**, or click the company name on any contact's record, or the
link under Outlook Category on an engagement. Search by name, domain or industry.

**What you can set:** name, website/domain, industry, physical address, relationship, Outlook category,
notes.

**Renaming** is safe and is the main thing this screen is for — every contact and engagement points at
the company by id, so they all follow the change automatically.

**Renaming onto a company that already exists is refused.** It looks like combining the two; it isn't.
You would end up with two rows sharing a name, each holding half the contacts, and nothing able to tell
them apart. Merging two organizations is a separate flow (see below) — until you use it, move contacts
across on their own records, or choose a name that distinguishes them.

**`/organizations?empty=1`** lists companies with no contacts and no engagements. Import residue, mostly.
Nothing needs doing about them; they just clutter the company dropdowns.

## Possible duplicate companies

**Where:** `/organizations` → *possible duplicates*. Each pair shows why it was suggested, how many
people and engagements are on each side, and how much is filled in on each.

**Three answers per pair:**

- **Keep "X"** — merges the other into X. Moves every contact and engagement, fills any field blank on X
  from the other, appends the other's notes, deletes the other row, and writes one audit line naming what
  moved. **Nothing is overwritten** — X's own values win.
- **Not a duplicate** — permanent. That pair is never offered again, including after an import adds
  contacts to either side. Add a note (why they are different) if it is not obvious.
- Leave it, and come back.

**Nothing merges on its own.** That is deliberate: some firms have legitimately separate entities, and an
automatic merge would be silent and wrong.

**On a domain match, read the two sides differently.** The side where the domain is used by most of the
emailed contacts is summarised in a sentence — that is simply the company's own domain. The side where it
is the exception lists those people by name, with their address and a **fix** link, because they are the
reason the pair exists.

**If one side is the domain's home and the other has one or two exceptions, it is probably not a
duplicate.** It is usually a contact filed under the wrong employer. The pair says so, points at the
person, and makes *Not a duplicate* the primary button rather than the merges. Fix the person, mark the
pair, move on — merging two real companies over one misfiled contact is the mistake this warning exists
to prevent.

**A merge cannot be undone from a screen.** The audit trail records both names and everything that moved,
so it can be reversed by hand, but choose deliberately. If the two really are one company under two
spellings and you only want the name fixed, **rename** on the company record instead.

**If the list looks too long or too noisy,** the tuning knob is `TOKEN_MAX_ORGS` in `src/orgdupes.ts` —
lower it and the distinctive-word rule offers fewer, more confident pairs. `STOPWORDS` in the same file is
the other lever: a word in that list never acts as a match key.

**If a third table ever points at `organization(id)`**, add it to the merge in `src/orgdupes.ts`. Today
only `contact` and `engagement` do. A missed table means rows orphaned by a merge, silently.
