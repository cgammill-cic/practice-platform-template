// The daily digest — one weekday email telling the operator what needs doing (DIGEST-001).
//
// THE POINT: the app comes to you. Everything else in here waits to be opened, which means the day fills
// up and the outreach does not happen. A morning list of what is actually due is the smallest thing that
// changes that.
//
// ---------------------------------------------------------------------------------------------------
// FIVE DECISIONS
//
// 1. SENT THROUGH GRAPH AS THE OPERATOR, TO THE OPERATOR. No email vendor, no API key, no domain to
//    verify, and open decision O-8 (which transactional email service) never has to be answered. Issue
//    #95 assumed a vendor was required and it is not: the Outlook connection already exists, so one
//    added scope does what an entire third-party integration was scoped to do.
//
// 2. IT ONLY EVER MAILS THE CONNECTED ACCOUNT. The recipient is `ms_connection.account_upn` — not a
//    parameter, not a setting, not derived from anything a contact controls. `Mail.Send` is the first
//    capability in this app that can send something to another human, and the narrowest useful version
//    of it is one that can only talk to its owner. There is no code path here that addresses anyone else.
//
// 3. SILENT WHEN THERE IS NOTHING DUE, but never silently broken. A "you have 0 items" email trains you
//    to ignore the sender, so an empty day sends nothing. The risk is that silence then means two things
//    — nothing due, or the digest is broken — so EVERY run writes an audit row saying which, and /health
//    reports the last outcome. Silence you can verify is fine; silence you cannot is the failure mode
//    this codebase keeps running into.
//
// 4. 6AM CENTRAL ALL YEAR, via two crons and an hour check. Cloudflare crons are UTC and do not shift
//    with daylight saving, so a single fixed entry drifts an hour twice a year — 6am becomes 5am, which
//    is the difference between a useful morning email and one that wakes you. Both 11:00 and 12:00 UTC
//    fire on weekdays and the run checks whether it is currently the 6 o'clock hour in Central; exactly
//    one of the two passes on any given day. The cost is one no-op invocation daily.
//
// 5. CAPPED, WITH THE TOTAL STATED. A digest that lists everything is a report, and reports get skimmed.
//    Each section shows at most SECTION_LIMIT rows and says how many more there are, so the email stays
//    the size of a morning rather than the size of the database.
// ---------------------------------------------------------------------------------------------------

import { Hono } from "hono";
import { graphBase, msAccessToken, msConnection } from "./msgraph";
import { pursuitsNeedingAttention } from "./pursuits";
import { DIGEST_ENABLED, isOn, setSetting } from "./settings";
import { esc } from "./views";
import type { Bindings, D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

const ACTOR = "operator";

/** Rows shown per section before the email says "and N more". */
const SECTION_LIMIT = 8;

/** The hour, in the operator's zone, that the digest is meant to arrive in. See decision 4. */
const SEND_HOUR_LOCAL = 6;
const LOCAL_ZONE = "America/Chicago";

/** Cron expressions that mean "maybe send the digest". The backup owns its own and is dispatched apart. */
export const DIGEST_CRONS = new Set(["0 11 * * 1-5", "0 12 * * 1-5"]);

interface Line {
  who: string;
  detail: string;
  href: string;
}
interface Section {
  title: string;
  urgent: boolean;
  lines: Line[];
  total: number;
}

/**
 * Today's date in the operator's timezone, not the server's.
 *
 * Every "due today" and "overdue" below is measured against THIS, passed into the SQL as a bound value,
 * rather than against `date('now')` — which SQLite evaluates in UTC. At the scheduled 6am Central send the
 * two agree, so this changes nothing about the daily email. It matters for the Send one now button, which
 * can be pressed at any hour: at 8pm Central, UTC has already rolled to tomorrow, so an unbounded
 * `date('now')` would include items due tomorrow under a heading that says today, and the date printed at
 * the top of the email would disagree with the rows underneath it. Same bug as MAIL-001's UTC date slice,
 * caught the same way — by looking at real output rather than reasoning about it.
 */
export function localToday(now: Date = new Date(), zone: string = LOCAL_ZONE): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * A stored timestamp — `audit_event.ts`, which SQLite writes in UTC — rendered in the operator's zone.
 *
 * Only /health's "last run" uses this. The question that panel answers is "did the digest go out this
 * morning?", and that is a local question: at 7pm Central the raw column reads 00:54 the following day,
 * which makes a run that happened an hour ago look like one that has not happened yet. The rest of the app
 * still shows raw stamps; this is not a campaign to convert them, it is the one place where the stamp is
 * being compared against a time of day the reader remembers.
 */
export function localStamp(utc: string): string {
  try {
    const d = new Date(`${utc.replace(" ", "T")}Z`);
    if (Number.isNaN(d.getTime())) return utc;
    return `${new Intl.DateTimeFormat("en-GB", {
      timeZone: LOCAL_ZONE,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d)} Central`;
  } catch {
    return utc;
  }
}

/** Is it currently the send hour in the operator's timezone? See decision 4 — this is the DST guard. */
export function isSendHour(now: Date, zone: string = LOCAL_ZONE, hour: number = SEND_HOUR_LOCAL): boolean {
  try {
    const h = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      hour12: false,
    }).format(now);
    return Number(h) === hour;
  } catch {
    // A broken Intl must not mean two emails a day; it means none, and /health will say so.
    return false;
  }
}

async function section(
  db: D1Db,
  title: string,
  urgent: boolean,
  sql: string,
  params: string[],
  toLine: (r: Record<string, unknown>) => Line
): Promise<Section> {
  const { results } = await db.prepare(sql).bind(...params).all<Record<string, unknown>>();
  return {
    title,
    urgent,
    lines: results.slice(0, SECTION_LIMIT).map(toLine),
    total: results.length,
  };
}

/**
 * What is due. Deliberately the same definitions the dashboard uses — a digest that disagrees with the
 * screen it summarises is worse than no digest, because then neither can be trusted.
 */
export async function buildDigest(db: D1Db, today: string = localToday()): Promise<Section[]> {
  const out: Section[] = [];

  out.push(
    await section(
      db,
      "Meetings today",
      true,
      `SELECT c.id, c.full_name, ifnull(c.meeting_time,'') AS t, ifnull(o.name,'') AS org
         FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
        WHERE c.status='active' AND c.meeting_date = ?
        ORDER BY c.meeting_time, c.full_name`,
      [today],
      (r) => ({
        who: String(r.full_name),
        detail: [r.t, r.org].filter(Boolean).join(" · ") || "no time set",
        href: `/contacts/${r.id}`,
      })
    )
  );

  out.push(
    await section(
      db,
      "Action items due",
      true,
      `SELECT a.id, a.description, a.due_date, c.id AS cid, c.full_name
         FROM action_item a JOIN contact c ON c.id = a.contact_id
        WHERE a.done = 0 AND a.due_date IS NOT NULL AND a.due_date <= ?
        ORDER BY a.due_date, c.full_name`,
      [today],
      (r) => ({
        who: String(r.full_name),
        detail: `${r.description} (due ${r.due_date})`,
        href: `/contacts/${r.cid}`,
      })
    )
  );

  /*
   * Overdue follow-ups, with the dashboard's exclusions applied verbatim: a booked meeting means the
   * meeting is the next step, terminal stages are finished with, and awaiting_response belongs to the
   * chase list below rather than appearing twice.
   */
  out.push(
    await section(
      db,
      "Follow-ups overdue",
      true,
      `SELECT c.id, c.full_name, c.next_follow_up, ifnull(o.name,'') AS org
         FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
        WHERE c.status='active' AND c.next_follow_up IS NOT NULL AND c.next_follow_up <= ?
          AND c.meeting_date IS NULL
          AND c.stage NOT IN ('complete','no_response','retired','not_qualified','awaiting_response')
        ORDER BY c.next_follow_up, c.full_name`,
      [today],
      (r) => ({
        who: String(r.full_name),
        detail: `due ${r.next_follow_up}${r.org ? ` · ${r.org}` : ""}`,
        href: `/contacts/${r.id}`,
      })
    )
  );

  /*
   * Pursuits (PURS-001). URGENT, and above "waiting on a reply" on purpose: an overdue next step on a
   * proposal is money with a date on it, whereas a contact who has not replied is a relationship. Both
   * matter; only one of them is a deal going quiet.
   *
   * The definitions are pursuitsNeedingAttention()'s, deliberately — the dashboard's section 8 and the
   * /pursuits screen use that same function, so the three cannot drift apart. DIGEST-001's rule again:
   * a summary that disagrees with the screen it summarises leaves neither trustworthy.
   */
  const duePursuits = await pursuitsNeedingAttention(db, today);
  out.push({
    title: "Pursuits needing you",
    urgent: true,
    lines: duePursuits.slice(0, SECTION_LIMIT).map((p) => ({
      who: p.name,
      detail: `${p.organization_name ? `${p.organization_name} · ` : ""}${p.why}`,
      href: `/engagements/${p.id}/edit`,
    })),
    total: duePursuits.length,
  });

  out.push(
    await section(
      db,
      "Waiting on a reply",
      false,
      `SELECT c.id, c.full_name, ifnull(o.name,'') AS org, c.escalation_rung AS rung,
              ifnull(c.last_attempt_at,'') AS laa
         FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
        WHERE c.status='active' AND c.stage='awaiting_response'
        ORDER BY (c.last_attempt_at IS NULL), c.last_attempt_at`,
      [],
      (r) => ({
        who: String(r.full_name),
        detail: `${r.rung} attempt${r.rung === 1 ? "" : "s"}${r.laa ? `, last ${r.laa}` : ", none recorded"}${
          r.org ? ` · ${r.org}` : ""
        }`,
        href: `/contacts/${r.id}`,
      })
    )
  );

  out.push(
    await section(
      db,
      "Meetings later this week",
      false,
      `SELECT c.id, c.full_name, c.meeting_date, ifnull(c.meeting_time,'') AS t
         FROM contact c
        WHERE c.status='active' AND c.meeting_date > ?
          AND c.meeting_date <= date(?, '+7 days')
        ORDER BY c.meeting_date, c.meeting_time`,
      [today, today],
      (r) => ({
        who: String(r.full_name),
        detail: `${r.meeting_date}${r.t ? ` ${r.t}` : ""}`,
        href: `/contacts/${r.id}`,
      })
    )
  );

  return out.filter((s) => s.total > 0);
}

/**
 * The digest links back to the app, so it needs the app's own URL — which is specific to each
 * deployment and cannot be hardcoded in a template. Set the optional `APP_URL` var in `wrangler.jsonc`
 * (e.g. `https://your-worker.your-subdomain.workers.dev`, or your custom domain) to get clickable links;
 * without it, the digest still sends, just without a dashboard link.
 */
function appOrigin(env: Bindings): string {
  return (env.APP_URL ?? "").replace(/\/+$/, "");
}

function renderHtml(sections: Section[], today: string, origin: string): string {
  const block = (s: Section) => `
    <h3 style="font:600 15px/1.3 system-ui,sans-serif;margin:20px 0 6px;color:${
      s.urgent ? "#b91c1c" : "#334155"
    }">${esc(s.title)} <span style="font-weight:400;color:#64748b">(${s.total})</span></h3>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
      ${s.lines
        .map(
          (l) => `<tr>
        <td style="padding:5px 0;font:400 14px/1.45 system-ui,sans-serif;color:#0f172a;border-bottom:1px solid #f1f5f9">
          <a href="${origin}${l.href}" style="color:#0f172a;text-decoration:none;font-weight:600">${esc(l.who)}</a>
          <span style="color:#64748b"> — ${esc(l.detail)}</span>
        </td></tr>`
        )
        .join("")}
      ${
        s.total > s.lines.length
          ? `<tr><td style="padding:5px 0;font:400 13px/1.45 system-ui,sans-serif;color:#64748b">…and ${
              s.total - s.lines.length
            } more</td></tr>`
          : ""
      }
    </table>`;

  return `<div style="max-width:600px;margin:0 auto;padding:8px 4px">
  <p style="font:400 13px/1.4 system-ui,sans-serif;color:#64748b;margin:0 0 2px">Practice Platform · ${esc(today)}</p>
  <h2 style="font:600 19px/1.3 system-ui,sans-serif;margin:0 0 4px;color:#0f172a">What needs you today</h2>
  ${sections.map(block).join("")}
  <p style="font:400 13px/1.5 system-ui,sans-serif;color:#64748b;margin:24px 0 0;padding-top:12px;border-top:1px solid #e2e8f0">
    ${origin ? `<a href="${origin}/" style="color:#334155">Open the dashboard</a> · <a href="${origin}/health" style="color:#334155">Turn this digest off</a><br>` : ""}
    Sent only on weekdays, and only when something is due — no email means nothing was.
  </p>
</div>`;
}

/** Plain text alongside the HTML, because a mail client that refuses HTML should still be readable. */
function renderText(sections: Section[], today: string, origin: string): string {
  return [
    `Practice Platform — ${today}`,
    "What needs you today",
    "",
    ...sections.flatMap((s) => [
      `${s.title.toUpperCase()} (${s.total})`,
      ...s.lines.map((l) => `  - ${l.who} — ${l.detail}`),
      ...(s.total > s.lines.length ? [`  ...and ${s.total - s.lines.length} more`] : []),
      "",
    ]),
    ...(origin ? [`Dashboard: ${origin}/`, `Turn this digest off: ${origin}/health`] : []),
  ].join("\n");
}

async function note(db: D1Db, outcome: string, detail: string) {
  await db
    .prepare(
      `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .bind(ACTOR, "digest", "daily", outcome, null, detail.slice(0, 500), "digest", `digest-${Date.now()}`)
    .run();
}

/**
 * The whole run. Returns a one-line outcome for the caller to log, and records one audit row per run
 * whatever happens — see decision 3. `force` bypasses the hour check for the Send a test button.
 */
export async function runDigest(
  env: Bindings,
  opts: { force?: boolean } = {}
): Promise<{ outcome: string; detail: string }> {
  const db = env.DB;

  if (!opts.force && !isSendHour(new Date())) {
    // The other cron of the pair. Not worth an audit row — it is the mechanism working, twice a day.
    return { outcome: "skipped", detail: "not the send hour in Central" };
  }

  if (!(await isOn(db, DIGEST_ENABLED))) {
    const r = { outcome: "off", detail: "the digest is switched off" };
    await note(db, r.outcome, r.detail);
    return r;
  }

  const conn = await msConnection(db);
  if (!conn?.account_upn) {
    const r = { outcome: "failed", detail: "Outlook is not connected, so there is nowhere to send" };
    await note(db, r.outcome, r.detail);
    return r;
  }

  const sections = await buildDigest(db);
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  if (!sections.length) {
    const r = { outcome: "nothing-due", detail: "nothing was due, so no email was sent" };
    await note(db, r.outcome, r.detail);
    return r;
  }

  const tok = await msAccessToken(env, db);
  if ("error" in tok) {
    const r = { outcome: "failed", detail: tok.error };
    await note(db, r.outcome, r.detail);
    return r;
  }

  const urgent = sections.filter((s) => s.urgent).reduce((n, s) => n + s.total, 0);
  const subject = urgent
    ? `${urgent} thing${urgent === 1 ? "" : "s"} need you today`
    : "Your day, and nothing overdue";

  /*
   * The recipient is the connected account and nothing else — see decision 2. `saveToSentItems` is false
   * so a daily note to yourself does not fill the Sent folder you actually search.
   */
  const res = await fetch(`${graphBase(env)}/me/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: renderHtml(sections, today, appOrigin(env)) },
        toRecipients: [{ emailAddress: { address: conn.account_upn } }],
      },
      saveToSentItems: false,
    }),
  });

  if (!res.ok) {
    const hint =
      res.status === 403
        ? " The connection may predate the Mail.Send permission — reconnect Outlook on /health."
        : "";
    const r = {
      outcome: "failed",
      detail: `Microsoft refused to send (HTTP ${res.status}).${hint}`,
    };
    await note(db, r.outcome, r.detail);
    return r;
  }

  const counted = sections.map((s) => `${s.title} ${s.total}`).join(", ");
  const r = { outcome: "sent", detail: `sent to ${conn.account_upn} — ${counted}` };
  await note(db, r.outcome, r.detail);
  return r;
}

/** The last run, for /health to report. Silence has to be verifiable — decision 3. */
export async function lastDigest(
  db: D1Db
): Promise<{ ts: string; outcome: string; detail: string } | null> {
  try {
    return await db
      .prepare(
        `SELECT ts, action AS outcome, ifnull(after_summary,'') AS detail
           FROM audit_event WHERE entity='digest' ORDER BY id DESC LIMIT 1`
      )
      .first<{ ts: string; outcome: string; detail: string }>();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the switch

app.post("/digest/toggle", async (c) => {
  const body = await c.req.parseBody();
  const on = body.on === "1";
  await setSetting(c.env.DB, DIGEST_ENABLED, on);
  await c.env.DB.prepare(
    `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(
      ACTOR,
      "setting",
      DIGEST_ENABLED,
      "update",
      null,
      `daily digest turned ${on ? "on" : "off"}`,
      "app",
      "digest-toggle"
    )
    .run();
  return c.redirect(`/health?digest=${on ? "on" : "off"}`);
});

/** Send one now, ignoring the hour. The only way to find out what it looks like without waiting a day. */
app.post("/digest/test", async (c) => {
  const r = await runDigest(c.env, { force: true });
  return c.redirect(`/health?digest=test&outcome=${encodeURIComponent(r.outcome)}`);
});

export default app;
