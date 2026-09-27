/*
 * REL-008 Part B — the outreach escalation ladder (#19).
 *
 * Part A (#53) gave the words. This gives the sequencing: who has gone quiet, what you have already
 * tried on them, how long it has been, and what to try next.
 *
 * THE DESIGN CHANGED ON CONTACT WITH THE DATA, and it is worth recording why. The issue specified a
 * strict ladder — rung 1 initial email, rung 2 follow-up email, rung 3 LinkedIn, rung 4 text — where
 * rung N means the next step is N+1. Then the nine live Awaiting Response contacts were examined:
 * every one had exactly one attempt, but one was messaged on LinkedIn, another was texted,
 * and the rest were emailed. Nobody had started at rung 1 and walked up.
 *
 * A prescriptive ladder would therefore have told the owner his next step was a "follow-up email" to
 * people he had never emailed. Confirmed with him 2026-08-01: track what has actually been tried, and
 * suggest the next untried channel without forbidding any other. So `escalation_rung` counts attempts
 * made rather than naming a position in a fixed sequence, and the suggestion below is advice.
 *
 * Two consequences of that choice:
 *
 *   - CHANNELS TRIED ARE DERIVED from the interactions, because that is a description of what
 *     happened, and history is the honest source for it. The COUNT and the DATE are stored on the
 *     contact instead, because those drive the worklist ordering and must not shift when an old
 *     interaction is edited (#19, the owner's decision on `last_attempt_at`).
 *
 *   - THE ATTEMPT COUNT SURVIVES A REPLY. The owner, 2026-08-01: keep it as history. "This one took four
 *     tries" is real intelligence about a relationship, so nothing resets it when the stage moves off
 *     awaiting_response. The number reads as historical from that point.
 *
 * Giving up is never automatic. The original acceptance criteria had rung 5 as "no response after the
 * full ladder → mark no_response"; that is offered as a button and nothing more. A contact silently
 * reclassified as ghosted because a counter reached 5 is precisely the invisible state change #30 was
 * about.
 */

import { Hono } from "hono";
import { ATTEMPT_SQL, ATTEMPT_TYPES } from "./attempts";
import { markLogged } from "./outreach";
import { esc, initials, layout, priorityBadge } from "./views";
import { PRIORITY_FIRST_ORDER, stageLabel, type Bindings, type Contact, type D1Db } from "./types";
import { actor } from "./auth";

const app = new Hono<{ Bindings: Bindings }>();
const today = () => new Date().toISOString().slice(0, 10);

/** One offerable outreach step: a channel, the words on the button, and why you would pick it. */
export interface Rung {
  channel: string;
  label: string;
  note: string;
}

/**
 * The channels an outreach attempt can use, in the order they are suggested.
 *
 * Email appears twice deliberately: the first is a first touch, the second is the "did this reach
 * you" follow-up, which is a different message (Part A rung 2) rather than a repeat.
 */
const LADDER: readonly Rung[] = [
  { channel: "email", label: "Email", note: "initial email" },
  { channel: "email", label: "Email again", note: "the “did this reach you” follow-up" },
  { channel: "linkedin", label: "LinkedIn", note: "emails may be going to spam" },
  { channel: "text", label: "Text", note: "keep it personal — no template" },
];

/**
 * Call is recordable (it has always been in VALID_CHANNELS and in the attempts count) but it was never
 * on the ladder, so it could never be suggested and had no button. It earns both here, as a fifth
 * option rather than a fifth rung: it is a different MODE on a route you already have, which is
 * exactly what is left to offer once every ladder channel with an address has been used. Mindy
 * Roehrig, 2026-08-01, is the case — phone only, already texted, and the ladder was suggesting email.
 */
const CALL_RUNG: Rung = { channel: "call", label: "Call", note: "pick up the phone — no template" };

/*
 * Derived from ATTEMPT_TYPES rather than listed again (#82). These two lists were identical by hand
 * before, and a channel that the buttons accept but the attempt definition does not count is precisely
 * how the stored column and the count on screen came to disagree.
 */
const VALID_CHANNELS = new Set<string>(ATTEMPT_TYPES);

/**
 * How long to wait for a reply before the chase comes back round (the owner, 2026-08-04).
 *
 * Recording an attempt used to set last_attempt_at and nothing else, so the contact kept drifting up
 * the chase list by silence alone and never appeared on a follow-up list. The silence clock says how
 * long it has been; it never said when to act. Three business days is the interval the owner asked for.
 */
const FOLLOW_UP_BUSINESS_DAYS = 3;

/**
 * N business days after a date, skipping Saturday and Sunday.
 *
 * Public holidays are NOT handled. Doing it properly needs a holiday calendar per jurisdiction, and
 * getting it half right — a hardcoded list that silently rots — would be worse than a rule that is
 * simple and stated: this counts weekdays. A follow-up landing on Thanksgiving is a date to move by
 * hand, not a reason to carry a calendar the app cannot keep current.
 *
 * UTC throughout, matching today() and every other date in the app, which stores plain YYYY-MM-DD.
 */
export function plusBusinessDays(from: string, n: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Which channels this contact can actually be reached on (#58).
 *
 * The ladder used to pick the next channel purely from what had been tried, never asking whether a
 * route for it existed, so the dashboard confidently recommended emailing people with no email
 * address. A worklist that recommends an impossible action trains you to distrust every row of it —
 * the same failure shape as the 59 Complete contacts that used to sit on the Overdue list.
 *
 * Text and call share the phone number, because they do.
 */
export interface Routes {
  email: boolean;
  linkedin: boolean;
  text: boolean;
  call: boolean;
  /**
   * There is no LinkedIn profile to be had (REL-011, migration 0011). Distinct from `linkedin: false`,
   * which only says no URL is on file — and the two want opposite things from the operator: one is a gap
   * worth filling, the other is a closed question. It lives on Routes rather than being passed alongside
   * because it IS route information: not "no address recorded" but "no such address exists".
   */
  linkedinAbsent: boolean;
}

const has = (v: string | null | undefined) => Boolean(v && v.trim() !== "");

export function routesFor(c: {
  email_work?: string | null;
  email_personal?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  no_linkedin?: number | null;
}): Routes {
  const phone = has(c.phone);
  const linkedin = has(c.linkedin_url);
  return {
    email: has(c.email_work) || has(c.email_personal),
    linkedin,
    text: phone,
    call: phone,
    // A URL on the record wins over the flag. They should never both be set — /linkedin clears the flag
    // when a URL is saved, and so does the Edit form — but if they ever are, the address that exists is
    // the more reliable fact than a note saying it does not.
    linkedinAbsent: !linkedin && Boolean(c.no_linkedin),
  };
}

const hasRoute = (routes: Routes, channel: string): boolean =>
  channel === "email" ? routes.email : channel === "linkedin" ? routes.linkedin : channel === "text" ? routes.text : routes.call;

/**
 * What to tell the operator to do next.
 *
 *   next    — an untried channel they actually have a route for. The normal case.
 *   repeat  — every channel with a route has been tried. Not a dead end: going again on a route that
 *             exists is a real move, and Call on a number you have already texted is a different act
 *             rather than a repeat. Shown ALONGSIDE the prompt to add a missing route (the owner,
 *             2026-08-01) — naming only the data-entry task would be telling him to go fill in a form
 *             when picking up the phone is right there.
 *   none    — no email, no phone, no LinkedIn URL. Nothing to suggest but adding one.
 */
export type Suggestion = { kind: "next" | "repeat"; rung: Rung } | { kind: "none" };

export interface ChaseRow extends Contact {
  attempts: number;
  channels_tried: string | null;
}

/**
 * Who is awaiting a response, longest silence first. A contact never contacted sorts to the very top:
 * "awaiting a response" with no attempt recorded means the outreach never actually happened, which is
 * worse than a chase that has gone quiet, and the same undated-first inversion the rest of the app uses.
 *
 * The derived attempts count and channels list use the shared ATTEMPT_SQL definition (#82). They used to
 * spell the channel list out here, one row above a pill reading `last_attempt_at` — which is how the same
 * row came to say "no attempt recorded" and "1 attempt · tried email" at the same time. The undated-first
 * ordering below is only trustworthy while every attempt actually reaches the stored column.
 */
export async function chaseList(db: D1Db): Promise<ChaseRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*, o.name AS organization_name,
          (SELECT COUNT(*) FROM interaction i WHERE i.contact_id = c.id
             AND ${ATTEMPT_SQL}) AS attempts,
          (SELECT group_concat(t, ', ') FROM
             (SELECT DISTINCT i.type AS t FROM interaction i WHERE i.contact_id = c.id
                AND ${ATTEMPT_SQL} ORDER BY i.type)) AS channels_tried
        FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
        WHERE c.status='active' AND c.stage='awaiting_response'
        ORDER BY ${PRIORITY_FIRST_ORDER}, (c.last_attempt_at IS NOT NULL), c.last_attempt_at, c.full_name`
    )
    .all<ChaseRow>();
  return results;
}

/**
 * The next channel worth trying: the first rung that has NOT been used and that the contact has a
 * route for, except that email is allowed twice before moving on. Still advice rather than a rule —
 * every channel with a route stays clickable on every row, and the ordering is a suggestion.
 *
 * The route check is the whole of #58. Everything else here is REL-008 Part B unchanged.
 */
export function suggestNext(attempts: number, channelsTried: string | null, routes: Routes): Suggestion {
  const tried = (channelsTried ?? "").split(", ").filter(Boolean);
  const emails = tried.includes("email") ? Math.max(1, attempts - (tried.length - 1)) : 0;
  const usable = (r: Rung) => hasRoute(routes, r.channel);

  if (usable(LADDER[0]) && !tried.includes("email")) return { kind: "next", rung: LADDER[0] };
  if (usable(LADDER[1]) && tried.includes("email") && emails < 2 && !tried.includes("linkedin") && !tried.includes("text"))
    return { kind: "next", rung: LADDER[1] };
  if (usable(LADDER[2]) && !tried.includes("linkedin")) return { kind: "next", rung: LADDER[2] };
  if (usable(LADDER[3]) && !tried.includes("text")) return { kind: "next", rung: LADDER[3] };
  if (routes.call && !tried.includes("call")) return { kind: "repeat", rung: CALL_RUNG };

  /*
   * Everything with a route has been tried at least once. Offer the most recent usable channel again
   * rather than nothing — "email again" after two emails is a judgement call the operator is entitled
   * to make, and an empty suggestion would read as "give up", which this feature refuses to say on its
   * own (REL-008 Part B).
   */
  const repeatable = [...LADDER, CALL_RUNG].filter(usable);
  if (!repeatable.length) return { kind: "none" };
  const last = repeatable[repeatable.length - 1];
  return { kind: "repeat", rung: { ...last, label: `${last.label} again`, note: "the only routes you have are used up" } };
}

/**
 * Channels the ladder would offer but cannot, because no address is on file. Drives the row prompt.
 *
 * A contact marked as having no LinkedIn profile is NOT listed as missing a LinkedIn URL (REL-011): the
 * prompt exists to name work worth doing, and telling someone to go find a profile that does not exist is
 * work that can only end in them ignoring the prompt. It is the same reason #58 stopped the ladder
 * recommending email to people with no email address.
 */
export function missingRoutes(routes: Routes): string[] {
  const gaps: string[] = [];
  if (!routes.email) gaps.push("an email address");
  if (!routes.linkedin && !routes.linkedinAbsent) gaps.push("a LinkedIn URL");
  if (!routes.text) gaps.push("a phone number");
  return gaps;
}

/** Whole days since a date, or null when there is nothing to measure from. */
export function daysSince(date: string | null): number | null {
  if (!date) return null;
  return Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
}

async function audit(db: D1Db, entity: string, id: number, action: string, after: string, contactId: number) {
  await db
    .prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,?,?,?,NULL,?,'app',?)"
    )
    .bind(actor(), entity, String(id), action, after, `contact-${contactId}`)
    .run();
}

/**
 * One row of the chase list. Shows what has been tried and how long it has been silent, then offers
 * every channel — with the suggested one first and emphasised.
 */
export function chaseRow(r: ChaseRow): string {
  const days = daysSince(r.last_attempt_at);
  const routes = routesFor(r);
  const next = suggestNext(r.attempts, r.channels_tried, routes);
  const dotClass = days === null ? "red" : days > 21 ? "red" : days > 10 ? "amber" : "grey";
  const silence =
    days === null
      ? '<span class="pill red">no attempt recorded</span>'
      : days > 21
        ? `<span class="pill red">silent ${days}d</span>`
        : days > 10
          ? `<span class="pill amber">silent ${days}d</span>`
          : `<span class="pill grey">silent ${days}d</span>`;

  /*
   * A button for a channel with no address is MUTED but still clickable (#58, the owner's call
   * 2026-08-01). Not disabled: the route may exist outside the app — his number is in your phone, not
   * in the contact record — and refusing would make the app wrong in the other direction. Clicking one
   * lands on a confirmation that asks for the detail first, so the only way to record an attempt on a
   * channel the app knows nothing about is to say so deliberately. Recording a fictional attempt is
   * worse than offering no button at all: it resets the silence clock and makes the trail wrong.
   */
  const button = (rung: Rung) => {
    const reachable = hasRoute(routes, rung.channel);
    const isNext = next.kind !== "none" && rung.channel === next.rung.channel && next.rung.label.startsWith(rung.label);
    const title = reachable
      ? rung.channel === "linkedin"
        ? `${rung.note} — opens their profile in a new tab once the attempt is logged`
        : rung.note
      : `no ${rung.channel === "email" ? "email address" : rung.channel === "linkedin" ? "LinkedIn URL" : "phone number"} on file — you will be asked to add one`;
    // LinkedIn opens in a new tab (#58's confirm page too, when there's no URL yet) so clicking it both
    // logs the attempt AND lands you on the profile to actually send the message — the dashboard tab is
    // left exactly where it was, same as the "Profile ↗" link on the contact record itself.
    return `<form method="post" action="/escalation/${r.id}/attempt" style="display:inline"${
      rung.channel === "linkedin" ? ' target="_blank"' : ""
    }>
        <input type="hidden" name="channel" value="${rung.channel}">
        <button class="tiny ${isNext && reachable ? "" : "secondary"}" type="submit"${
          reachable ? "" : ' style="opacity:.45"'
        } title="${esc(title)}">${esc(rung.label)}</button>
      </form>`;
  };

  // The suggestion line, and — only when there is nothing untried left to offer — the missing routes.
  // Naming the gaps on every row would be noise: most contacts are missing something they do not need.
  const gaps = next.kind === "next" ? [] : missingRoutes(routes);
  const gapPrompt = gaps.length
    ? `<div class="meta">adding ${
        gaps.length > 1 ? `${gaps.slice(0, -1).join(", ")} or ${gaps[gaps.length - 1]}` : gaps[0]
      } on <a href="/contacts/${r.id}/edit">their record</a> would open another channel</div>`
    : "";
  const suggestion =
    next.kind === "none"
      ? '<div class="meta"><b>No way to reach them.</b> No email, phone or LinkedIn URL is on file.</div>'
      : `<div class="meta">suggest: <b>${esc(next.rung.label)}</b> — ${esc(next.rung.note)}</div>`;

  return `<div class="listrow">
    <span class="dot ${dotClass}"></span>
    <span class="avatar">${esc(initials(r.full_name))}</span>
    <div class="listrow-main">
      <div class="listrow-name"><a href="/contacts/${r.id}">${esc(r.full_name)}</a> ${priorityBadge(r)}</div>
      ${r.organization_name ? `<div class="meta">${esc(r.organization_name)}</div>` : ""}
    </div>
    <div class="listrow-meta">${silence}</div>
    <div style="flex-basis:100%">
      <div class="meta">${
        r.attempts
          ? `${r.attempts} attempt${r.attempts === 1 ? "" : "s"} · tried ${esc(r.channels_tried ?? "")}`
          : "nothing tried yet"
      }</div>
      ${suggestion}
      ${gapPrompt}
      <div class="quickset" style="border-top:0;padding-top:8px">
        ${[...LADDER, CALL_RUNG].map(button).join(" ")}
        <a href="/templates?contact=${r.id}">get the words</a>
        <form method="post" action="/escalation/${r.id}/give-up" style="display:inline">
          <button class="secondary tiny" type="submit">Give up</button>
        </form>
      </div>
    </div>
  </div>`;
}

/** Dashboard section 3. */
export function chaseBlock(rows: ChaseRow[]): string {
  if (!rows.length)
    return '<div class="empty">Nobody is awaiting a response. Anyone you have chased and not heard from appears here, longest silence first.</div>';
  const never = rows.filter((r) => !r.last_attempt_at).length;
  const stale = rows.filter((r) => (daysSince(r.last_attempt_at) ?? 0) > 21).length;
  const blocked = rows.filter((r) => suggestNext(r.attempts, r.channels_tried, routesFor(r)).kind !== "next").length;
  return `<div class="list">${rows.map(chaseRow).join("")}</div>
  <p class="meta" style="margin-top:8px">Priority contacts first, then longest silence. Buttons record the attempt, log it in the history, reset the clock, and set a follow-up ${FOLLOW_UP_BUSINESS_DAYS} business days out — the highlighted one is the suggestion, and the order is advice rather than a rule. Faded buttons are channels with no address on file; they still work, but they ask you to add the detail first. <b>Give up</b> moves the contact to No Response and is never automatic.${
    never ? ` <b>${never} ${never === 1 ? "has" : "have"} no attempt recorded at all.</b>` : ""
  }${stale ? ` ${stale} silent more than three weeks.` : ""}${
    blocked ? ` ${blocked} ${blocked === 1 ? "has" : "have"} no untried channel left with an address on file.` : ""
  }</p>`;
}

// ---------------------------------------------------------------- writes

const ROUTE_LABEL: Record<string, string> = {
  email: "email address",
  linkedin: "LinkedIn URL",
  text: "phone number",
  call: "phone number",
};

/**
 * The confirmation shown when you click a channel the contact has no address for (#58).
 *
 * It exists to make one distinction the app cannot make for you: whether the route is genuinely
 * missing, or merely missing FROM HERE. Both are common — his number is in your phone, her email is in
 * a thread you can find — so this asks rather than refuses. Adding the detail is the first and
 * emphasised option, because a route recorded once serves every future chase; recording the attempt
 * alone helps this row and leaves the next one just as blind.
 */
app.get("/escalation/:id/confirm", async (c) => {
  const id = Number(c.req.param("id"));
  const channel = c.req.query("channel") ?? "";
  if (!VALID_CHANNELS.has(channel)) return c.redirect("/?flash=badchannel");
  const contact = await c.env.DB.prepare("SELECT full_name FROM contact WHERE id = ?")
    .bind(id)
    .first<{ full_name: string }>();
  if (!contact) return c.notFound();
  const what = ROUTE_LABEL[channel];

  return c.html(
    layout({ c,
      title: "Add a route first?",
      body: `<main>
  <h1>No ${esc(what)} on file</h1>
  <p class="sub">for <a href="/contacts/${id}">${esc(contact.full_name)}</a></p>
  <div class="card">
    <p>You are about to record a <b>${esc(channel)}</b> attempt, but this record has no ${esc(what)}. Two ways that happens, and they want different things:</p>
    <ul>
      <li><b>You do have it, it just is not here.</b> Add it, then record the attempt — every later chase gets it too.</li>
      <li><b>You reached them some other way.</b> Record it anyway; the history will note the ${esc(what)} was not in the app.</li>
    </ul>
    <div class="actions">
      <a class="btn" href="/contacts/${id}/edit">Add the ${esc(what)}</a>
      <form method="post" action="/escalation/${id}/attempt" style="display:inline">
        <input type="hidden" name="channel" value="${esc(channel)}">
        <input type="hidden" name="confirm_no_route" value="1">
        <button class="secondary" type="submit">Record it anyway</button>
      </form>
      <a class="btn secondary" href="/">Cancel</a>
    </div>
    <p class="meta" style="margin-top:12px">Nothing has been recorded yet. Recording an attempt that did not happen is worse than recording none — it resets the silence clock and puts this contact behind the ones you really have chased.</p>
  </div>
</main>`,
    })
  );
});

/**
 * Log an outreach you sent outside the app (2026-09-25). Linked from the Priority Circle Outreach page
 * (a claude.ai artifact of drafted LinkedIn messages): that page cannot write to this app, so its "Log
 * it" button opens this confirmation in a new tab, and one click here records the attempt through the
 * same POST the chase list uses. A GET never writes; recording happens only on the button.
 */
app.get("/escalation/:id/log", async (c) => {
  const id = Number(c.req.param("id"));
  const channel = c.req.query("channel") ?? "linkedin";
  if (!VALID_CHANNELS.has(channel)) return c.redirect("/?flash=badchannel");
  const contact = await c.env.DB.prepare("SELECT full_name, stage FROM contact WHERE id = ?")
    .bind(id)
    .first<{ full_name: string; stage: string }>();
  if (!contact) return c.notFound();
  return c.html(
    layout({ c,
      title: "Log outreach",
      body: `<main>
  <h1>Log a ${esc(channel === "linkedin" ? "LinkedIn message" : channel)}</h1>
  <p class="sub">to <a href="/contacts/${id}">${esc(contact.full_name)}</a>, sent today (${esc(today())})</p>
  <form class="card" method="post" action="/escalation/${id}/attempt">
    <input type="hidden" name="channel" value="${esc(channel)}">
    <input type="hidden" name="confirm_no_route" value="1">
    <input type="hidden" name="return" value="logged">
    <label for="log-subject">Subject</label>
    <input type="text" id="log-subject" name="subject" value="Initial outreach" maxlength="200">
    <label for="log-summary">What you sent <span class="hint">optional, paste the message to keep it in their history</span></label>
    <textarea id="log-summary" name="summary" rows="6"></textarea>
    <div class="actions"><button type="submit">Log it</button> <a class="btn secondary" href="/contacts/${id}">Cancel</a></div>
    <p class="meta" style="margin-top:12px">Records the message in their history, counts it on the chase ladder, and sets a follow-up ${FOLLOW_UP_BUSINESS_DAYS} business days out.${
      contact.stage === "not_contacted" ? " Because this is your first outreach to them, they also move from Not Contacted to Awaiting Response, the same as a first email." : ""
    }</p>
  </form>
</main>`,
    })
  );
});

app.get("/escalation/:id/logged", async (c) => {
  const id = Number(c.req.param("id"));
  const contact = await c.env.DB.prepare("SELECT full_name, stage, next_follow_up FROM contact WHERE id = ?")
    .bind(id)
    .first<{ full_name: string; stage: string; next_follow_up: string | null }>();
  if (!contact) return c.notFound();
  return c.html(
    layout({ c,
      title: "Logged",
      body: `<main>
  <p class="flash ok">Logged for <a href="/contacts/${id}">${esc(contact.full_name)}</a>. Stage: ${esc(stageLabel(contact.stage))}${contact.next_follow_up ? `, follow up ${esc(contact.next_follow_up)}` : ""}.</p>
  <p class="meta">You can close this tab and go back to your outreach list.</p>
</main>`,
    })
  );
});

app.post("/escalation/:id/attempt", async (c) => {
  const id = Number(c.req.param("id"));
  const f = await c.req.parseBody();
  const channel = typeof f.channel === "string" ? f.channel : "";
  if (!VALID_CHANNELS.has(channel)) return c.redirect("/?flash=badchannel");

  const before = await c.env.DB.prepare(
    "SELECT full_name, stage, escalation_rung, last_attempt_at, next_follow_up, email_work, email_personal, phone, linkedin_url FROM contact WHERE id = ?"
  )
    .bind(id)
    .first<{
      full_name: string;
      stage: string;
      escalation_rung: number;
      last_attempt_at: string | null;
      next_follow_up: string | null;
      email_work: string | null;
      email_personal: string | null;
      phone: string | null;
      linkedin_url: string | null;
    }>();
  if (!before) return c.notFound();

  // No address for this channel, and no deliberate confirmation yet: ask before writing anything.
  const noRoute = !hasRoute(routesFor(before), channel);
  if (noRoute && f.confirm_no_route !== "1")
    return c.redirect(`/escalation/${id}/confirm?channel=${encodeURIComponent(channel)}`);

  /*
   * An attempt is an interaction, not just a counter bump. Recording it any other way would leave the
   * history unable to explain why the rung moved, which is the same gap REL-025 closed for commitments.
   * Direction is outbound because that is what an attempt is, and it is the field that would otherwise
   * let an inbound reply be mistaken for a chase.
   */
  const inserted = await c.env.DB.prepare(
    `INSERT INTO interaction (contact_id, date, type, direction, subject, summary)
     VALUES (?,?,?, 'outbound', ?, ?)`
  )
    .bind(
      id,
      today(),
      channel,
      // The log page (above) supplies its own subject and, optionally, the message text.
      typeof f.subject === "string" && f.subject.trim() ? f.subject.trim().slice(0, 200) : `Outreach attempt — ${channel}`,
      typeof f.summary === "string" && f.summary.trim()
        ? f.summary.trim()
        : f.return === "logged"
          ? `${channel === "linkedin" ? "LinkedIn message" : channel} logged from the outreach list.`
          : `Escalation attempt recorded from the dashboard chase list.${
              noRoute ? ` No ${ROUTE_LABEL[channel]} was on file, so this was confirmed by hand — the address used is not recorded here.` : ""
            }`
    )
    .run();
  const interactionId = inserted?.meta?.last_row_id ?? 0;

  /*
   * The attempt also sets the next follow-up, three business days out (the owner, 2026-08-04).
   *
   * It OVERWRITES any existing date rather than keeping the earlier one. The attempt is the newest
   * fact about this relationship: having just chased them, waiting for a reply before chasing again is
   * the right next step, and an older date set before the attempt is reasoning from a stale position.
   * The audit event below records the move so nothing is lost silently.
   *
   * last_touch is deliberately NOT set here. It is derived from interactions, and the insert above
   * already makes this date the newest one, so recomputing keeps the two consistent by construction.
   */
  const nextFollowUp = plusBusinessDays(today(), FOLLOW_UP_BUSINESS_DAYS);
  await c.env.DB.prepare(
    `UPDATE contact SET escalation_rung = escalation_rung + 1, last_attempt_at = ?, next_follow_up = ?,
       last_touch = (SELECT MAX(date) FROM interaction WHERE contact_id = ? AND date <= date('now')),
       updated_at = datetime('now') WHERE id = ?`
  )
    .bind(today(), nextFollowUp, id, id)
    .run();

  await audit(
    c.env.DB,
    "interaction",
    interactionId,
    "create",
    `${before.full_name} · outreach attempt by ${channel} on ${today()}${noRoute ? ` · confirmed with no ${ROUTE_LABEL[channel]} on file` : ""}`,
    id
  );
  await audit(
    c.env.DB,
    "contact",
    id,
    "update",
    `attempt ${before.escalation_rung} → ${before.escalation_rung + 1} by ${channel}; last_attempt_at ${before.last_attempt_at ?? "none"} → ${today()}; next_follow_up ${before.next_follow_up ?? "none"} → ${nextFollowUp} (${FOLLOW_UP_BUSINESS_DAYS} business days)`,
    id
  );
  /*
   * First outreach moves Not Contacted → Awaiting Response (2026-09-25), the same rule email import
   * applies to a first outbound email (applyFirstOutreachTransition in mailimport.ts). Written here
   * rather than imported, because mailimport already imports from this file. The chase list only shows
   * Awaiting Response contacts, so this changes nothing there; it matters for the outreach-list path.
   */
  if (before.stage === "not_contacted") {
    const moved = await c.env.DB.prepare(
      "UPDATE contact SET stage = 'awaiting_response', updated_at = datetime('now') WHERE id = ? AND stage = 'not_contacted'"
    )
      .bind(id)
      .run();
    if ((moved.meta?.changes ?? 0) > 0)
      await audit(
        c.env.DB,
        "contact",
        id,
        "update",
        `stage ${stageLabel("not_contacted")} → ${stageLabel("awaiting_response")} (first outreach on record, by ${channel}, ${today()})`,
        id
      );
  }
  // Outreach drafting (Phase 2a): "Log as Sent" on a draft card posts here with the item id, so the
  // draft leaves the Drafts list and the ladder moves exactly as for any other logged outreach.
  if (typeof f.outreach_item === "string" && /^\d+$/.test(f.outreach_item))
    await markLogged(c.env.DB, { itemId: Number(f.outreach_item), contactId: id });
  if (f.return === "outreach") return c.redirect("/outreach?flash=logged");
  if (f.return === "logged") return c.redirect(`/escalation/${id}/logged`);

  /*
   * LinkedIn's button submits with target="_blank" (the owner, 2026-09-22: "take me to the profile of
   * that person to make it easier") specifically so this redirect lands in the NEW tab it opened —
   * the dashboard tab is left alone, same as clicking the "Profile ↗" link on the contact record
   * itself. Only when there is actually a URL on file: `noRoute` means there is not, and the confirm
   * page it already went through is the destination in that case, not this handler.
   */
  const linkedinProfile =
    channel === "linkedin" && before.linkedin_url && /^https?:\/\//i.test(before.linkedin_url)
      ? before.linkedin_url
      : null;
  return c.redirect(linkedinProfile ?? `/?flash=${noRoute ? "attemptnoroute" : "attempt"}`);
});

/**
 * Giving up. Explicit, audited, and reversible by editing the contact — the stage is a fact recorded
 * by a person, never a side effect of a counter.
 */
app.post("/escalation/:id/give-up", async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare(
    "SELECT full_name, stage, escalation_rung, next_follow_up FROM contact WHERE id = ?"
  )
    .bind(id)
    .first<{ full_name: string; stage: string; escalation_rung: number; next_follow_up: string | null }>();
  if (!before) return c.notFound();

  // No Response is terminal, so the follow-up date goes with it: a contact you have stopped chasing
  // has no next step, and leaving a date would put them straight back on the overdue list (#14).
  await c.env.DB.prepare(
    "UPDATE contact SET stage='no_response', next_follow_up=NULL, updated_at=datetime('now') WHERE id=?"
  )
    .bind(id)
    .run();
  await audit(
    c.env.DB,
    "contact",
    id,
    "update",
    `gave up chasing after ${before.escalation_rung} attempt${before.escalation_rung === 1 ? "" : "s"}; stage ${before.stage} → no_response; next_follow_up ${before.next_follow_up ?? "none"} → none`,
    id
  );
  return c.redirect(`/?flash=gaveup`);
});

export default app;
