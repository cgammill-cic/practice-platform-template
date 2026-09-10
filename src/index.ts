import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import actionsApp, { actionBlock, openActions } from "./actions";
import auditApp from "./audit";
import escalationApp, { chaseBlock, chaseList } from "./escalation";
import { runBackup, recordBackupFailure, backupStatus } from "./backup";
import contactList from "./contactList";
import contacts from "./contacts";
import digestApp, { DIGEST_CRONS, runDigest } from "./digest";
import engagementsApp from "./engagements";
import orgDupesApp from "./orgdupes";
import organizationsApp from "./organizations";
import pursuitsApp, { pursuitsNeedingAttention } from "./pursuits";
import timeApp, { entriesForWeek } from "./time";
import { MANIFEST, iconBytes, markBytes } from "./icons";
import exportsApp from "./exports";
import health from "./health";
import importer from "./importer";
import bulkUpdateApp from "./bulkupdate";
import linkedinApp, { missingLinkedInCount } from "./linkedin";
import calImportApp from "./calimport";
import mailImportApp from "./mailimport";
import feedbackApp from "./feedback";
import activitiesApp, { loadActivities, nonWorkNames } from "./activities";
import msGraphApp from "./msgraph";
import pipelineApp from "./pipeline";
import referralsApp from "./referrals";
import templatesApp from "./templates";
import { vocabularyStatus } from "./vocabulary";
import { esc, followUpPill, formatTime, layout } from "./views";
import {
  ACTIVE_STAGES,
  ENGAGEMENT_STATUSES,
  MEETING_OUTCOMES,
  labelFor,
  TERMINAL_STAGES,
  stageLabel,
  type Bindings,
  type Contact,
} from "./types";
import { NEXT_WEEK_END, NEXT_WEEK_START, THIS_WEEK_END, weekBounds } from "./weeks";

const app = new Hono<{ Bindings: Bindings }>();

const COOKIE = "pp_session";
/** Which dashboard sections are collapsed (#70). Display state only — never read for anything else. */
const DASH_COOKIE = "pp_dash_closed";
/*
 * How long a sign-in lasts. Thirty days, decided 2026-08-04 (UX-001, #56), up from seven.
 *
 * Seven days meant re-typing the passphrase weekly, and on a phone that is the friction that stops you
 * opening the app in the ninety seconds after a meeting — which is the whole reason UX-001 exists. The
 * cost is the honest one: a lost phone holds a live session for up to thirty days rather than seven.
 *
 * What actually contains that risk is not the number: rotating SESSION_SECRET invalidates every session
 * everywhere, immediately, and it is one field in the Cloudflare dashboard (docs/runbook.md → Secrets).
 * A stolen device is answered in thirty seconds by rotating, not by having chosen a shorter expiry a
 * month earlier. The cookie remains httpOnly, Secure and SameSite=Lax, and the token is HMAC-signed
 * with its own expiry inside, so lengthening this does not weaken anything else.
 */
const SESSION_DAYS = 30;
const enc = new TextEncoder();

/**
 * How far ahead "Upcoming Follow-Ups" looks (REL-004, #14). Fourteen days, from the issue itself.
 *
 * A rolling window rather than a week boundary, deliberately: the meeting sections use Sunday–Saturday
 * because that is how a calendar is read, but a follow-up due in three days is equally worth seeing
 * whether it lands this week or next. Sunday would otherwise be the day the list emptied itself.
 */
const UPCOMING_FOLLOW_UP_DAYS = 14;

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

/** Constant-time comparison of byte arrays (lengths equalized via hashing first). */
function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function makeToken(secret: string): Promise<string> {
  const expires = String(Date.now() + SESSION_DAYS * 86400_000);
  return `${expires}.${await hmac(secret, expires)}`;
}

async function isAuthed(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  return safeEqual(enc.encode(sig), enc.encode(await hmac(secret, expires)));
}

const loginPage = (error = "") =>
  layout({
    title: "Sign In",
    nav: false,
    body: `<form class="card" method="post" action="/login" style="max-width:380px;margin:80px auto">
  <!-- The sign-in page is the one screen with no content of its own, so the mark gets room here that it
       does not get in the header. Still the mark alone, not a full wordmark — see icons.ts. -->
  <img src="/logo.png" alt="" width="105" height="48" style="display:block;margin:0 auto 14px">
  <h1 style="text-align:center">Practice Platform</h1>
  ${error ? `<p class="flash warn">${esc(error)}</p>` : ""}
  <label>Passphrase</label>
  <input type="password" name="passphrase" autofocus autocomplete="current-password">
  <div class="actions"><button type="submit" style="width:100%">Sign In</button></div>
</form>`,
  });

app.get("/login", (c) => c.html(loginPage()));

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const supplied = typeof form.passphrase === "string" ? form.passphrase : "";
  const ok = safeEqual(await sha256(supplied), await sha256(c.env.APP_PASSWORD));
  if (!ok) return c.html(loginPage("That passphrase is not correct."), 401);
  setCookie(c, COOKIE, await makeToken(c.env.SESSION_SECRET), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return c.redirect("/");
});

app.get("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.redirect("/login");
});

/*
 * Home Screen assets (UX-001, #56). Registered ABOVE the auth middleware on purpose — these three
 * routes are the only public ones besides /login.
 *
 * They have to be. iOS fetches the manifest and the icon while installing a Home Screen shortcut, and
 * those requests do not reliably carry the session cookie; behind auth they would redirect to /login,
 * and the install would silently fall back to a screenshot icon with no error anywhere. Nothing here is
 * data — an app name, two colours and a public logo.
 *
 * The icon is served at both paths rather than redirected: iOS asks for /apple-touch-icon.png at the
 * site root on its own, whether or not the link tag exists, and a 301 there is one more thing that can
 * behave differently between iOS versions for no gain.
 */
const iconResponse = () =>
  // .buffer, cast: the Workers Response accepts an ArrayBuffer, and the DOM lib's BodyInit does not
  // include the ArrayBufferLike-parameterised Uint8Array that TS 5.7 now infers. The bytes are the same.
  new Response(iconBytes().buffer as ArrayBuffer, {
    headers: {
      "content-type": "image/png",
      // A week. The icon changes when the logo changes, which is not often, and iOS caches Home Screen
      // icons aggressively anyway — after replacing it, the shortcut has to be re-added to see the new one.
      "cache-control": "public, max-age=604800",
    },
  });
app.get("/icon.png", () => iconResponse());
app.get("/apple-touch-icon.png", () => iconResponse());
/*
 * The header mark (2026-08-05). Public for the same reason and with less at stake: it is on every page
 * including /login, which is served before anyone has a session, so behind auth it would be a broken
 * image on the one screen a stranger can reach. It is a transparent-background crop of the same logo.
 */
app.get("/logo.png", () =>
  new Response(markBytes().buffer as ArrayBuffer, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=604800" },
  })
);
app.get("/manifest.webmanifest", () =>
  new Response(JSON.stringify(MANIFEST), {
    headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" },
  })
);

// Everything below requires a valid session.
app.use("*", async (c, next) => {
  if (await isAuthed(getCookie(c, COOKIE), c.env.SESSION_SECRET)) return next();
  return c.redirect("/login");
});

// ---------------------------------------------------------------- dashboard

const listOrEmpty = (rows: Contact[], empty: string, extra?: (r: Contact) => string) =>
  rows.length
    ? `<table><tbody>${rows
        .map(
          (r) => `<tr>
        <td><a href="/contacts/${r.id}"><b>${esc(r.full_name)}</b></a>${r.organization_name ? `<div class="meta">${esc(r.organization_name)}</div>` : ""}</td>
        <td>${extra ? extra(r) : `<span class="pill grey">${esc(stageLabel(r.stage))}</span>`}</td>
        <td style="text-align:right" data-label="Follow-up">${followUpPill(r.next_follow_up, r.stage)}</td>
      </tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="empty">${empty}</div>`;

/** Meeting rows carry the meeting date/time and the resolution actions inline. */
const meetingList = (rows: Contact[], empty: string) =>
  rows.length
    ? `<table><tbody>${rows
        .map(
          (r) => `<tr>
        <td>
          <a href="/contacts/${r.id}"><b>${esc(r.full_name)}</b></a>
          ${r.organization_name ? `<div class="meta">${esc(r.organization_name)}</div>` : ""}
        </td>
        <td data-label="Meeting"><b>${esc(r.meeting_date)}</b>${r.meeting_time ? `<div class="meta">${esc(formatTime(r.meeting_time))}</div>` : ""}</td>
        <td style="text-align:right" data-label="Log the outcome">${MEETING_OUTCOMES.map(
          ([v, label]) =>
            `<a class="pill" style="margin-left:4px" href="/contacts/${r.id}?log_meeting=${v}#record">${esc(label)}</a>`
        ).join("")}</td>
      </tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="empty">${empty}</div>`;

/** Why a contact landed in Needs Attention — stated per row so the fix is obvious. */
function attentionReason(r: Contact): string {
  if (r.stage === "meeting_scheduled" && !r.meeting_date)
    return '<span class="pill red">Meeting Scheduled · no meeting date</span>';
  if (r.stage === "follow_up_action")
    return '<span class="pill red">You owe the next move · no date set</span>';
  /*
   * A CADENCE-HAVING CONTACT IS STILL SHOWN HERE, and this row explains why (REL-027, #93).
   *
   * The issue asked for the opposite — suppress Stay Connected and Pray contacts once a cadence is set,
   * "because the cadence is its next step". That is wrong on inspection and was not built: a cadence only
   * produces a date when an interaction is recorded, so a contact with a cadence and no touch yet has no
   * date and no next step at all. Suppressing them would make them invisible, which is the one failure
   * this section exists to prevent — and it would do it to exactly the contacts whose cadence says they
   * matter.
   *
   * So the row stays and names the fix: record a touch and the cadence takes over from then on.
   */
  /*
   * The reason goes on a second line rather than inside the pill. `.pill` is white-space:nowrap, so a
   * sentence in one pushed the dashboard 22px wider than a 390px phone — measured, and the same mistake
   * .grid2 dd was fixed for in #86. Pills are for short labels; explanations are prose.
   */
  if (r.touch_interval_days)
    return `<span class="pill amber">${esc(stageLabel(r.stage))}</span>
      <div class="meta">every ${esc(r.touch_interval_days)} days, but no touch recorded yet</div>`;
  return `<span class="pill amber">${esc(stageLabel(r.stage))} · no follow-up date</span>`;
}

/**
 * An owed commitment with no date on it is the single easiest thing to lose, so section 2 says so on
 * the row rather than leaving a quiet grey "none set" to be scrolled past.
 */
function owedNote(r: Contact): string {
  if (!r.next_follow_up) return '<span class="pill red">no date — set one</span>';
  return `<span class="meta">${esc(r.notes ? r.notes.slice(0, 70) : "")}</span>`;
}

app.get("/", async (c) => {
  const b = await backupStatus(c.env.DB).catch(() => null);
  // Vocabulary drift is banner-worthy: it either breaks a dropdown or hides a contact entirely (REL-022).
  const v = await vocabularyStatus(c.env.DB).catch(() => null);
  const banners = [
    !b || b.state === "ok"
      ? ""
      : `<div class="banner ${b.state === "none" ? "info" : "warn"}">${esc(b.message)} <a href="/health">details</a></div>`,
    !v || v.state === "ok"
      ? ""
      : `<div class="banner warn">Stage vocabulary: ${esc(v.message)} <a href="/health">details</a></div>`,
  ].join("");

  /*
   * Collapsible sections (#70). Seven sections stacked, and reaching section 7 means scrolling past
   * six; collapsing the ones already dealt with turns the page into a short index.
   *
   * Whole sections only, ruling out nested collapse inside a section and also
   * ruling out the cheaper "auto-collapse the empty ones" idea, on the grounds that an empty section
   * is already one line and costs no real estate. That removed the only option that worked without
   * persisted state, which is what makes the cookie below necessary rather than a nicety: this
   * dashboard is the redirect target of every quick-set button and every recorded attempt, so plain
   * <details> would spring back open several times an hour. A collapse that will not stay collapsed
   * is worse than no collapse at all.
   *
   * Cookie rather than a ui_preference table: one user, one browser at a time, no audit interest in
   * which panels are shut. A migration and a POST round-trip per toggle is a lot of machinery for a
   * scroll problem — and if this ever needs to follow the operator across devices, that is the moment
   * to move it server-side, not now.
   *
   * The cookie is client-written, so it is whitelisted rather than trusted: only the literal section
   * numbers 1-7 survive parsing. Anything else in that header is discarded and the section opens.
   */
  const closedSections = new Set(
    /*
     * THE RANGE HAS TO GROW WITH THE SECTIONS. It read /^[1-7]$/ when PURS-001 added section 8, which
     * silently made that one section un-collapsible: the toggle wrote "8" into the cookie, the whitelist
     * dropped it on the way back, and the section reopened on every render. No error, no clue — the
     * feature just did not work for the newest section. Adding a section means changing this pattern.
     */
    (getCookie(c, DASH_COOKIE) ?? "").split(".").filter((s) => /^[1-8]$/.test(s))
  );
  const openAttr = (n: number) => (closedSections.has(String(n)) ? "" : " open");

  const q = async (sql: string, ...params: unknown[]) =>
    (await c.env.DB.prepare(sql).bind(...params).all<Contact>()).results;

  const base = `SELECT c.*, o.name AS organization_name FROM contact c LEFT JOIN organization o ON o.id = c.organization_id WHERE c.status='active'`;
  const activeStageList = ACTIVE_STAGES.map((s) => `'${s}'`).join(",");
  /*
   * Both follow-up lists exclude the terminal stages (2026-08-01: "I've marked them complete
   * with no follow up, I don't need to be reminded... I don't need no response on the overdue follow
   * up list").
   *
   * This is a filter, not a workaround for bad data. The 59 imported Complete and No Response contacts
   * that were carrying past dates have had those dates cleared, so today the filter changes nothing.
   * It exists so the noise cannot come back — and it will be load-bearing shortly, because marking
   * more contacts Not Qualified is next week's work, and any of them carrying an old date would
   * otherwise reappear as overdue the moment their stage changed.
   */
  const terminalStageList = TERMINAL_STAGES.map((s) => `'${s}'`).join(",");

  /*
   * SECTION 3 OWNS AWAITING RESPONSE, so section 6 does not repeat it (2026-08-04).
   *
   * A second exclusion with a second reason, kept separate from the terminal-stage filter above rather
   * than folded into one list: terminal stages are excluded because they have no next step at all, and
   * this stage is excluded because its next step is already on the screen, one section up.
   *
   * Why now: #82. Recording a chase attempt sets a follow-up three business days out, so every contact
   * being chased now acquires a date — and lands on both lists. Counted on prod immediately after that
   * fix, 17 of the 18 contacts in section 3 were also sitting under Upcoming, which is 17 of the 40 rows
   * there. Section 6 was becoming a copy of section 3 with the useful part removed.
   *
   * Nothing is lost by the exclusion, which is the test #75 established for suppressing a row: section 3
   * has NO date filter — it shows every active contact in awaiting_response, always — so a contact
   * cannot fall out of both. It is a stricter guarantee than the meeting rule, where section 1 only
   * covers dates inside its windows and the unresolved list catches the rest.
   *
   * What section 3 says instead is better suited to the decision: how long they have been silent, what
   * you have already tried, and what to try next. "Due today" on a follow-up list cannot answer any of
   * those, and a chase is the one activity where the date was never the interesting fact.
   *
   * The residual cost, stated plainly: a follow-up date set BY HAND on a contact awaiting a response is
   * now visible only on their record, because the chase row shows silence rather than the date. That is
   * accepted — the date on those rows is almost always the one the chase button just wrote — and it is
   * cheap to revisit: chaseRow() could carry followUpPill() if a hand-set date ever needs to show.
   *
   * As with #75, next_follow_up is NOT cleared. Suppressing a row from a view is reversible and visible
   * on the record; rewriting a date nobody touched is the silent move this codebase keeps refusing.
   */
  const chaseOwnedStage = "'awaiting_response'";

  // Meetings are driven by meeting_date (migration 0004), not by stage. Weeks run Sunday–Saturday.
  const meetingsThisWeek = await q(
    `${base} AND c.meeting_date IS NOT NULL AND c.meeting_date >= date('now') AND c.meeting_date <= ${THIS_WEEK_END}
     ORDER BY c.meeting_date, c.meeting_time`
  );
  const meetingsNextWeek = await q(
    `${base} AND c.meeting_date IS NOT NULL AND c.meeting_date >= ${NEXT_WEEK_START} AND c.meeting_date <= ${NEXT_WEEK_END}
     ORDER BY c.meeting_date, c.meeting_time`
  );
  // A meeting whose date has passed but was never resolved: held-and-not-logged, cancelled, or a no-show.
  const meetingsUnresolved = await q(
    `${base} AND c.meeting_date IS NOT NULL AND c.meeting_date < date('now') ORDER BY c.meeting_date`
  );
  const meetingsLater = await q(
    `${base} AND c.meeting_date IS NOT NULL AND c.meeting_date > ${NEXT_WEEK_END} ORDER BY c.meeting_date LIMIT 10`
  );

  /*
   * Section 2 — what you owe. Two layers, deliberately in this order (REL-007 + REL-020):
   *   the specific commitments first, because "send the two-page overview" is actionable, and
   *   then the contacts whose court the ball is in without an itemized commitment attached.
   * Undated entries lead both lists: a commitment with no date is worse than a late one, because
   * nothing else will ever raise it.
   */
  const actions = await openActions(c.env.DB).catch(() => []);
  const owed = await q(
    `${base} AND c.stage='follow_up_action' ORDER BY (c.next_follow_up IS NOT NULL), c.next_follow_up, c.full_name`
  );
  const owedUndated = owed.filter((r) => !r.next_follow_up).length;

  // Section 3 is now the escalation ladder (REL-008 Part B) rather than a bare stage list: the useful
  // question is not "who is awaiting a response" but "who has been silent longest, and what have I
  // already tried on them". chaseList() orders by silence and carries the attempt history.
  const chasing = await chaseList(c.env.DB).catch(() => []);
  const pushing = await q(
    `${base} AND c.stage='in_conversation' AND c.meeting_date IS NULL ORDER BY (c.next_follow_up IS NULL), c.next_follow_up`
  );
  /*
   * A booked meeting suppresses BOTH follow-up lists (#75, 2026-08-04).
   *
   * The `meeting_date IS NULL` predicate below used to be on the Upcoming query only. The comment
   * above that query, the section 6 footer text, and this filter all claimed the rule applied to
   * both — and for a long time nothing disproved it, because almost nobody sat in meeting_scheduled
   * with a follow-up date already past. Reconciling the five stage/meeting mismatches on 2026-08-04
   * (#69) put four contacts in exactly that state, and they appeared twice on one screen: in
   * section 1 with a meeting, and again under Overdue as if they were late.
   *
   * Settled the way the copy already described: the meeting IS the next step, so a contact with one
   * belongs in section 1 and nowhere else. A deliberate call, and the residual risk is owned directly —
   * where a real commitment is outstanding AND a meeting is booked, it gets recorded as an action item
   * in section 2, which names what is owed rather than merely when. That is the honest home for it;
   * the follow-up date never said what the commitment was.
   *
   * Deliberately NOT done: clearing next_follow_up when a meeting is booked. Suppressing a row from
   * a view is reversible and visible on the record; rewriting a date nobody touched is the silent
   * class of move this codebase keeps refusing to make.
   */
  const overdue = await q(
    `${base} AND c.next_follow_up IS NOT NULL AND c.next_follow_up <= date('now')
       AND c.meeting_date IS NULL
       AND c.stage NOT IN (${terminalStageList})
       AND c.stage <> ${chaseOwnedStage}
     ORDER BY c.next_follow_up`
  );
  /*
   * Upcoming follow-ups (REL-004, #14). The half of that issue that was never built: until now a
   * follow-up appeared on no list until the day it went overdue, so the dashboard could only tell you
   * about a commitment once you were already late.
   *
   * No BACKLOG stage filter. The issue's own scoping note suggested excluding not_contacted and
   * reach_out_later to avoid overlapping section 5, but that turns out to be unnecessary and slightly
   * wrong on both counts:
   *   - There is no overlap. Section 5 shows backlog contacts whose date has arrived or is absent;
   *     this shows dates still in the future. The two sets are disjoint by construction.
   *   - A Reach Out Later snooze expiring in five days is exactly the kind of thing worth seeing
   *     coming. Excluding it would recreate, in a new place, the same silence REL-016 fixed.
   *
   * The TERMINAL stages ARE excluded, which is a different decision and was made on evidence rather
   * than taste: 59 Complete and No Response contacts were carrying imported past dates and made up
   * about three quarters of the Overdue list. A finished contact has no next step by definition, so it
   * belongs on neither list.
   *
   * Contacts with a scheduled meeting are excluded too — see the note on the Overdue query above,
   * which is where that rule is now explained. Until #75 this comment was the only statement of it
   * and the Overdue query did not implement it.
   *
   * Contacts awaiting a response are excluded as well, for the reasons set out beside chaseOwnedStage.
   */
  const upcoming = await q(
    `${base} AND c.next_follow_up > date('now')
       AND c.next_follow_up <= date('now','+${UPCOMING_FOLLOW_UP_DAYS} days')
       AND c.meeting_date IS NULL
       AND c.stage NOT IN (${terminalStageList})
       AND c.stage <> ${chaseOwnedStage}
     ORDER BY c.next_follow_up, c.full_name`
  );
  /*
   * Outreach batch — backlog contacts that are actually actionable now. A deliberate deferral date is
   * respected: a contact set to Reach Out Later in 8 weeks is NOT in this week's batch. Found
   * 2026-07-30, when a contact snoozed for 56 days appeared reading "in 56d" on the same line.
   */
  const batch = await q(
    `${base} AND c.stage IN ('not_contacted','reach_out_later')
       AND (c.next_follow_up IS NULL OR c.next_follow_up <= date('now'))
     ORDER BY (c.priority_tier IS NULL), c.priority_tier, c.full_name LIMIT 15`
  );
  const batchTotals = await c.env.DB.prepare(
    `SELECT
       SUM(next_follow_up IS NOT NULL AND next_follow_up > date('now')) AS deferred,
       SUM(next_follow_up IS NULL OR next_follow_up <= date('now')) AS ready
     FROM contact WHERE status='active' AND stage IN ('not_contacted','reach_out_later')`
  ).first<{ deferred: number; ready: number }>();
  /*
   * Needs Attention — the catch-all that guarantees no active contact can be invisible.
   */
  const needsAttention = await q(
    `${base} AND (
        (c.next_follow_up IS NULL AND c.meeting_date IS NULL AND c.stage IN (${activeStageList}))
        OR (c.stage='meeting_scheduled' AND c.meeting_date IS NULL)
     ) ORDER BY c.full_name`
  );
  const totals = await c.env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(status='active') AS active FROM contact"
  ).first<{ total: number; active: number }>();
  /*
   * The count for the Missing LinkedIn link (REL-011, #26). Not a dashboard section: it is data-entry
   * work rather than a relationship needing a next step, and section 7 already guarantees no active
   * contact goes invisible. A link in the sub-line — the same treatment /referrals gets — with the count
   * on it, so it is one of the things you can see needs doing without being an eighth thing to scroll past.
   */
  const missingLinkedIn = await missingLinkedInCount(c.env.DB).catch(() => 0);
  /*
   * Hours logged so far this week (TIME-001, #90). A LINK WITH A NUMBER ON IT, not an eighth section.
   *
   * The dashboard answers "what do I do today" about relationships; time entry is a different activity
   * with its own page and its own week navigation, and a section here would either duplicate that page or
   * be a number with nothing to do. But the number itself belongs on the screen the operator opens every
   * day, because the failure mode for a timesheet is forgetting it exists until Friday.
   *
   * The FULL Sunday–Saturday week containing today, deliberately unlike the meeting sections above, which
   * run today→Saturday because a meeting that already happened is not upcoming. Hours already worked are
   * exactly what this is counting, so the week cannot start at today.
   *
   * Non-work activities (Personal, and since migration 0026 whatever else is flagged that way) are
   * excluded here, matching the report's definition of "worked" — two places now depend on that rule, so
   * it comes from the same activity table both read rather than being spelled out twice.
   */
  const hoursWeek = weekBounds(new Date().toISOString().slice(0, 10));
  const hoursThisWeek = await Promise.all([
    entriesForWeek(c.env.DB, hoursWeek.start, hoursWeek.end),
    loadActivities(c.env.DB),
  ])
    .then(([rows, activityRows]) => {
      const nonWork = nonWorkNames(activityRows);
      return rows.filter((r) => !nonWork.has(r.activity)).reduce((n, r) => n + r.hours, 0);
    })
    .catch(() => 0);
  const weekEnds = await c.env.DB.prepare(
    `SELECT ${THIS_WEEK_END} AS this_end, ${NEXT_WEEK_START} AS next_start, ${NEXT_WEEK_END} AS next_end`
  ).first<{ this_end: string; next_start: string; next_end: string }>();

  const readyCount = batchTotals?.ready ?? 0;

  /*
   * Pursuits due today. Wrapped in a catch that yields an empty list, matching how `openActions` behaves
   * beside it — and noted as the same accepted risk: a failure here shows as "nothing due", which is
   * indistinguishable from a quiet week. It is on the list to fix properly for both.
   */
  const pursuitsDue = await pursuitsNeedingAttention(c.env.DB).catch(() => []);

  return c.html(
    layout({
      title: "Dashboard",
      banner: banners,
      body: `<main>
  ${
    { attempt: '<div class="flash ok">Attempt recorded. It is in the contact’s history and the silence clock has reset.</div>',
      attemptnoroute: '<div class="flash warn">Attempt recorded, and the history notes there was no address on file for that channel. Worth adding it to the contact record so the next chase is not blind too.</div>',
      gaveup: '<div class="flash ok">Moved to No Response and the follow-up date cleared. Nothing about it was automatic — change the stage on the record if you want them back.</div>',
      badchannel: '<div class="flash warn">That was not a channel I recognise, so nothing was recorded.</div>' }[c.req.query("flash") ?? ""] ?? ""
  }
  <h1>Weekly Dashboard</h1>
  <p class="sub">${totals?.total ?? 0} contacts (${totals?.active ?? 0} active) · <a href="/contacts">browse all</a> · <a href="/actions">action items</a> · <a href="/templates">templates</a> · <a href="/referrals">referrals</a> · <a href="/import">import</a> · <a href="/health">system health</a>${
        missingLinkedIn ? ` · <a href="/linkedin">${missingLinkedIn} missing LinkedIn</a>` : ""
      }</p>
  <p class="sub" style="margin-top:-14px"><a href="/time">${
    hoursThisWeek ? `${hoursThisWeek % 1 === 0 ? hoursThisWeek : hoursThisWeek.toFixed(2).replace(/0$/, "")} hours logged this week` : "log time"
  }</a> · <a href="/time/report">weekly hours</a> · <a href="/engagements">customers</a></p>

  <section><details class="dash" data-sec="1"${openAttr(1)}>
    <summary><h2>1 · Upcoming Meetings</h2></summary>
    ${
      meetingsUnresolved.length
        ? `<h3 style="font-size:13px;color:#b91c1c;margin:4px 0 6px">Needs Resolution — date has passed</h3>
           ${meetingList(meetingsUnresolved, "")}
           <p class="meta" style="margin:6px 0 16px">Held, cancelled, or a no-show — pick one and the interaction gets recorded.</p>`
        : ""
    }
    <h3 style="font-size:13px;color:var(--muted);margin:4px 0 6px">This Week — through ${esc(weekEnds?.this_end ?? "Saturday")}</h3>
    ${meetingList(meetingsThisWeek, "No meetings scheduled for the rest of this week.")}
    <h3 style="font-size:13px;color:var(--muted);margin:16px 0 6px">Next Week — ${esc(weekEnds?.next_start ?? "")} to ${esc(weekEnds?.next_end ?? "")}</h3>
    ${meetingList(meetingsNextWeek, "Nothing on the calendar for next week yet.")}
    ${
      meetingsLater.length
        ? `<h3 style="font-size:13px;color:var(--muted);margin:16px 0 6px">Further Out</h3>${meetingList(meetingsLater, "")}`
        : ""
    }
    <p class="meta" style="margin-top:10px">Weeks run Sunday–Saturday. Meeting dates are set on the contact record; Outlook calendar sync arrives in Phase 2.</p>
  </details></section>

  <section><details class="dash" data-sec="2"${openAttr(2)}>
    <summary><h2>2 · What You Owe${actions.length || owed.length ? ` (${actions.length} item${actions.length === 1 ? "" : "s"}, ${owed.length} contact${owed.length === 1 ? "" : "s"})` : ""}</h2></summary>
    <h3 style="font-size:13px;color:var(--muted);margin:4px 0 6px">Action items — things you committed to <a href="/actions" style="font-weight:400">manage all</a></h3>
    ${actionBlock(actions)}
    <h3 style="font-size:13px;color:var(--muted);margin:18px 0 6px">Contacts whose next move is yours</h3>
    ${listOrEmpty(owed, "Nobody is in the Follow-Up Action stage.", owedNote)}
    <p class="meta" style="margin-top:8px">Action items are specific commitments and can be ticked off individually. The stage below says the ball is in your court without naming what you owe.${
      owedUndated ? ` <b>${owedUndated} contact${owedUndated === 1 ? "" : "s"} need${owedUndated === 1 ? "s" : ""} a follow-up date.</b>` : ""
    }</p>
  </details></section>

  <section><details class="dash" data-sec="3"${openAttr(3)}>
    <summary><h2>3 · Chase Non-Responders${chasing.length ? ` (${chasing.length})` : ""}</h2></summary>
    ${chaseBlock(chasing)}
  </details></section>

  <section><details class="dash" data-sec="4"${openAttr(4)}>
    <summary><h2>4 · In Conversation${pushing.length ? ` (${pushing.length})` : ""}</h2></summary>
    ${listOrEmpty(pushing, "Nobody in conversation without a meeting scheduled.")}
  </details></section>

  <section><details class="dash" data-sec="5"${openAttr(5)}>
    <summary><h2>5 · Outreach Batch — Ready Now${readyCount ? ` (${readyCount})` : ""}</h2></summary>
    ${listOrEmpty(batch, "No backlog contacts are due — use <a href=\"/import\">import</a> to load the spreadsheet.", (r) => `<span class="pill grey">Tier ${esc(r.priority_tier ?? "—")}</span>`)}
    <p class="meta" style="margin-top:8px">Backlog contacts (Not Contacted, Reach Out Later) with no follow-up date or one that has arrived, highest tier first.${
      readyCount > batch.length ? ` Showing ${batch.length} of ${readyCount} ready.` : ""
    }${
      batchTotals?.deferred
        ? ` ${batchTotals.deferred} more ${batchTotals.deferred === 1 ? "is" : "are"} deliberately deferred and will appear when due.`
        : ""
    }</p>
  </details></section>

  <section><details class="dash" data-sec="6"${openAttr(6)}>
    <summary><h2>6 · Follow-Ups${overdue.length || upcoming.length ? ` (${overdue.length} overdue, ${upcoming.length} coming up)` : ""}</h2></summary>
    <h3 style="font-size:13px;color:#b91c1c;margin:4px 0 6px">Overdue — the date has arrived</h3>
    ${listOrEmpty(overdue, "Nothing overdue — every scheduled follow-up is still in the future.")}
    <h3 style="font-size:13px;color:var(--muted);margin:16px 0 6px">Upcoming — due within ${UPCOMING_FOLLOW_UP_DAYS} days</h3>
    ${listOrEmpty(upcoming, `Nothing due in the next ${UPCOMING_FOLLOW_UP_DAYS} days.`)}
    <p class="meta" style="margin-top:8px">Overdue is a follow-up date that has passed; upcoming is the same list before the date arrives, soonest first, so a commitment is visible before you are late rather than after. <b>Complete, No Response, Retired and Not Qualified never appear here</b> — you have finished with them, so there is nothing to be reminded of; find them by stage on the <a href="/contacts">contacts list</a>. Contacts with a meeting booked appear in section 1 instead, since the meeting is the next step, and contacts <b>awaiting a response appear in section 3 only</b> — that list holds every one of them and says how long they have been silent, which is the more useful prompt than a date. A contact you owe may also appear in section 2: that names what you owe, this names when. Overdue action items are in section 2, marked in red.</p>
  </details></section>

  <section><details class="dash" data-sec="7"${openAttr(7)}>
    <summary><h2>7 · Needs Attention${needsAttention.length ? ` (${needsAttention.length})` : ""}</h2></summary>
    ${listOrEmpty(needsAttention, "Nothing adrift — every active relationship has a next step or a meeting booked.", attentionReason)}
    <p class="meta" style="margin-top:8px">The catch-all: active relationships with no next step, Meeting Scheduled with no meeting date, and Follow-Up Actions with no date. Complete, No Response, Retired, Not Qualified, and backlog contacts are excluded by design.</p>
  </details></section>

  ${/*
    SECTION 8, ADDED RATHER THAN INSERTED (PURS-001). Pursuits arguably matter more than sections 5 to 7
    — they are the revenue — but the section numbers are the keys the collapse cookie stores, so
    inserting a new 2 would silently reopen or re-close every section the operator has set. A number is
    cheaper to argue about than a remembered layout that quietly resets. Say the word and it moves.
  */ ""}
  <section><details class="dash" data-sec="8"${openAttr(8)}>
    <summary><h2>8 · Pursuits Needing You${pursuitsDue.length ? ` (${pursuitsDue.length})` : ""}</h2></summary>
    ${
      pursuitsDue.length
        ? `<ul class="rows">${pursuitsDue
            .map(
              (p) => `<li><a href="/engagements/${p.id}/edit"><b>${esc(p.name)}</b></a>
        <span class="meta">${esc(p.organization_name ?? "no customer set")} · ${esc(
          labelFor(ENGAGEMENT_STATUSES, p.status)
        )}</span>
        <div class="meta">${esc(p.why)}</div></li>`
            )
            .join("")}</ul>`
        : '<p class="meta">Nothing due — every open pursuit has its next step and its decision date still ahead of it.</p>'
    }
    <p class="meta" style="margin-top:8px">Open pursuits whose next step is due, or whose expected decision date has arrived. This is the sales pipeline, not the relationship pipeline — the full list with amounts and the demand report is on <a href="/pursuits">Pursuits</a>. A pursuit with no dated next step cannot appear here at all, which is why that field is nagged about on the form.</p>
  </details></section>

  <p class="meta" style="text-align:center;margin-top:20px"><a href="/health">System health and backups</a> · <a href="/audit">audit trail</a></p>
  <!-- The second script in the app (#70), and the whole reason the collapse is worth having: the
       dashboard is re-rendered on every quick-set button and every recorded attempt, so without this
       a section would re-open several times an hour. It writes display state to a cookie and nothing
       else — the server whitelists what comes back, so the worst a corrupted value can do is leave a
       section open.
       Listening on document in the CAPTURE phase is deliberate: the toggle event does not bubble, so
       a normal document-level listener never fires. Recomputing the whole set on each toggle rather
       than patching the cookie keeps it self-correcting — one write, no drift.
       Known and accepted: toggle is dispatched asynchronously, so collapsing a section and clicking a
       button in the same instant can navigate before the write lands, and that one collapse is lost.
       Measured in a real browser while building this — two clicks read back one write behind until a
       frame passed. Binding to click instead would close the window but would also miss the keyboard
       path, and the cost of the miss is a section that stays open. Not worth the trade. -->
  <script>
    document.addEventListener("toggle", function (e) {
      if (!e.target.dataset || !e.target.dataset.sec) return;
      var closed = [];
      document.querySelectorAll("details.dash").forEach(function (d) {
        if (!d.open) closed.push(d.dataset.sec);
      });
      document.cookie = "${DASH_COOKIE}=" + closed.join(".") + ";path=/;max-age=31536000;samesite=lax;secure";
    }, true);
  </script>
</main>`,
    })
  );
});

// Mount order no longer decides behaviour. Since the duplicate GET /contacts was removed from
// contacts.ts (#37), no (method, path) pair is registered twice across these eleven modules and no
// route shadows another, so these lines can be reordered safely. Ownership, for orientation:
// contactList owns GET /contacts and the contact delete/inactivate routes (REL-017, REL-019);
// contacts.ts owns the record, the add/edit forms, and the interactions; exportsApp owns /export
// and the CSV downloads (REL-006); templatesApp owns /templates (REL-008 Part A);
// auditApp owns /audit (AUD-002); escalationApp owns /escalation (REL-008 Part B);
// referralsApp owns /referrals (REL-005); linkedinApp owns /linkedin (REL-011);
// engagementsApp owns /engagements (CUST-001); timeApp owns /time and /time/report (TIME-001);
// msGraphApp owns /auth/microsoft* (M365-001) — behind the session gate on purpose, see msgraph.ts;
// calImportApp owns /time/import. It is mounted BEFORE timeApp, and that matters: timeApp registers
// GET /time/:id/edit, which has two path segments after /time and so cannot shadow /time/import — but
// keeping the more specific module first means a future /time/:something route cannot start swallowing it.
// What IS still load-bearing is the app.use("*") session gate above: Hono middleware only wraps
// routes registered after it, so these mounts must stay below it or they become unauthenticated.
app.route("/", health);
app.route("/", auditApp);
app.route("/", escalationApp);
app.route("/", referralsApp);
app.route("/", actionsApp);
app.route("/", contactList);
app.route("/", importer);
app.route("/", bulkUpdateApp);
app.route("/", linkedinApp);
app.route("/", engagementsApp);
app.route("/", pursuitsApp);
app.route("/", orgDupesApp);
app.route("/", organizationsApp);
app.route("/", msGraphApp);
app.route("/", pipelineApp);
app.route("/", calImportApp);
app.route("/", mailImportApp);
app.route("/", timeApp);
app.route("/", exportsApp);
app.route("/", templatesApp);
app.route("/", contacts);
app.route("/", digestApp);
app.route("/", feedbackApp);
app.route("/", activitiesApp);

export default {
  fetch: app.fetch,
  /*
   * Three cron entries now share this handler, so it dispatches on which one fired rather than doing
   * everything on every tick. Without the check the backup would run three times a day and the digest
   * would attempt a send at 07:00 — which the hour guard would refuse, but relying on a second guard to
   * undo a wrong dispatch is how a schedule quietly becomes wrong.
   */
  scheduled(
    event: { cron?: string },
    env: Bindings,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ) {
    const cron = event?.cron ?? "";
    if (DIGEST_CRONS.has(cron)) {
      ctx.waitUntil(runDigest(env).catch(() => undefined));
      return;
    }
    ctx.waitUntil(runBackup(env, "cron").catch((e) => recordBackupFailure(env, e)));
  },
};
