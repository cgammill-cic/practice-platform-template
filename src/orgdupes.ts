/*
 * ORG-002 — the possible-duplicate organizations queue.
 *
 * ============================================================================================
 * THE CONSTRAINT THAT SHAPED THIS
 * ============================================================================================
 * Some companies have sub-businesses that are legitimately separate — a professional-services firm can
 * have several real, distinct practices that look like near-duplicates by name alone.
 *
 * So: NOTHING IS EVER MERGED AUTOMATICALLY. Every rule below is a suggestion with a stated reason, and the
 * three answers are merge, not-a-duplicate, or leave it for later. A rule that collapsed similar names
 * would eventually merge two genuinely separate entities and there would be nothing on any screen to say
 * so.
 *
 * "Not a duplicate" is STORED (migration 0023), which is the difference between a queue you work through
 * and a queue you abandon. Without it, pairs already judged would reappear on every visit and again every
 * time an import touches either side.
 *
 * ============================================================================================
 * WHY THIS IS NOT A BRUTE-FORCE COMPARISON
 * ============================================================================================
 * A few thousand organizations already produce millions of unordered pairs. Comparing them all in a
 * Worker request is the same cost model that has caused large imports to time out elsewhere in this app,
 * and the lesson there was to stop iterating over the cross product.
 *
 * So candidates are BLOCKED first — standard record-linkage practice. A pair is only ever compared if it
 * shares a blocking key:
 *
 *   1. the normalised name (punctuation, legal suffixes and and/& removed)
 *   2. an email domain, taken from the contacts at each company
 *   3. a distinctive word — a token appearing in a FEW companies, never a common one
 *
 * Rule 3 is what catches near-miss spellings of the same firm — two names that normalise to different
 * strings and share no first word, but share a distinctive token that appears in almost nothing else. A
 * token appearing in more than TOKEN_MAX_ORGS companies is discarded as a blocking key, because
 * `consulting` or `group` would otherwise generate thousands of pairs and nothing useful. That cap is the
 * whole reason this is tractable.
 *
 * ============================================================================================
 * WHY THE REASON IS SHOWN ON EVERY ROW
 * ============================================================================================
 * A shared email domain and a shared distinctive word are very different levels of evidence, and the
 * person judging needs to know which they are looking at. Showing "same email domain: example.com" lets a
 * pair be decided in a second; showing a bare "possible duplicate" makes every pair equally expensive to
 * think about, which is how a 40-pair queue becomes a 40-pair backlog.
 */

import { Hono } from "hono";
import { esc, layout } from "./views";
import { ORG_RELATIONSHIP, labelFor, type Bindings, type D1Db } from "./types";

const app = new Hono<{ Bindings: Bindings }>();
const ACTOR = "operator";

/**
 * A word shared by more than this many companies is not distinctive, so it is not a blocking key.
 *
 * Six is judgement, not arithmetic. It has to be above 2 — a genuine multi-entity firm can legitimately
 * have three or four rows, and they all need to be offered against each other — and low enough that
 * industry words are excluded. In practice the tokens this admits are surnames and coined names; the ones
 * it rejects are `consulting`, `group`, `health`, `partners`, `services`.
 */
const TOKEN_MAX_ORGS = 6;

/** The queue shows this many pairs at once. A longer list is a backlog, not a task. */
const PAGE = 40;

/** Legal-form words stripped before comparison. Not an exhaustive list of the world's company suffixes. */
const SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "plc", "co", "corp", "corporation",
  "company", "gmbh", "sa", "nv", "bv", "ag", "pty", "pc", "pa",
]);

/**
 * Words too common to distinguish one company from another. Stripped from the token index only — they
 * are still part of the normalised name, because "Example Group" and "Example Health" must not normalise
 * to the same string just because `group` and `health` are unhelpful as search keys.
 */
const STOPWORDS = new Set([
  "the", "of", "and", "for", "group", "holdings", "partners", "associates", "consulting", "consultants",
  "advisors", "advisory", "services", "service", "solutions", "systems", "technologies", "technology",
  "international", "global", "national", "american", "us", "usa", "north", "america", "management",
  "capital", "ventures", "industries", "enterprises", "health", "healthcare", "financial", "bank",
  "insurance", "energy", "media", "software", "data", "digital", "labs", "works", "studio", "agency",
]);

/**
 * Everything that is punctuation, legal form, or the word "and" comes out; `&` becomes `and` first so
 * both spellings meet in the middle. This is the single function every rule below agrees on, and getting
 * it wrong in one place would produce pairs whose stated reason does not match why they were offered.
 */
export function normalizeName(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = base.split(" ").filter((w) => w && w !== "and" && !SUFFIXES.has(w));
  return words.join(" ");
}

export function tokensOf(normalized: string): string[] {
  return normalized.split(" ").filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/**
 * Levenshtein distance, capped. Only ever run on already-blocked pairs of normalised names, so the input
 * count is in the hundreds rather than the millions.
 *
 * The cap matters: beyond `max` the exact distance is irrelevant to the decision, so the row is abandoned
 * early rather than filled in. Two names 30 edits apart are not a near-miss worth measuring.
 */
export function editDistance(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

interface OrgLite {
  id: number;
  name: string;
  norm: string;
  domain: string | null;
  relationship_status: string | null;
  contact_count: number;
  engagement_count: number;
  /** Contacts here that carry a work email — the denominator for "is this domain normal at this company". */
  emailed: number;
  filled: number;
}

/** A contact whose own email address is what put its company into a pair. */
export interface Culprit {
  id: number;
  name: string;
  email: string;
}

export interface Candidate {
  a: OrgLite;
  b: OrgLite;
  /** Ranked: 1 strongest. Drives ordering and the wording of the reason. */
  strength: number;
  reason: string;
  /*
   * THE PEOPLE WHO ACTUALLY CAUSED A DOMAIN MATCH, one list per side. Empty for the name-based rules,
   * where the whole company matched and no individual is to blame.
   *
   * This mattered in practice: an earlier version of this rule collapsed matches down to a set of company
   * ids and then offered a link to every contact at that company, throwing away the one fact that makes a
   * pair decidable — which individuals actually share the domain — and asking the reviewer to re-derive by
   * hand, one company at a time, what the query had already computed.
   */
  aPeople: Culprit[];
  bPeople: Culprit[];
}

const key = (x: number, y: number) => (x < y ? `${x}:${y}` : `${y}:${x}`);

/**
 * Every candidate pair, strongest evidence first, already filtered against the "not a duplicate" table.
 *
 * The four rules, and why each is where it is in the ranking:
 *
 *   1. SHARED EMAIL DOMAIN — the strongest signal available and it needs no name similarity at all.
 *      People at the same company have the same email domain; that is what a company domain IS. Free
 *      providers are excluded, or every contact with a gmail address would match every other.
 *   2. IDENTICAL NORMALISED NAME — "Example Engineers, Inc." and "Example Engineers LLC". Only punctuation
 *      and legal form separate them, and a legal-form difference is occasionally real, which is why this
 *      is a suggestion rather than an automatic merge.
 *   3. ONE NAME CONTAINS THE OTHER — "Example" inside "Example Engineers". Common in a list built by
 *      typing company names on the fly, such as during calendar-category matching.
 *   4. A DISTINCTIVE SHARED WORD, plus a small edit distance or a strong word overlap — catches near-miss
 *      spellings of the same firm. Weakest of the four and deliberately last, because it is the one that
 *      will offer pairs that are not duplicates. That is acceptable when the answer is one click and
 *      remembered forever.
 */
export async function candidates(db: D1Db, limit = PAGE): Promise<{ rows: Candidate[]; total: number }> {
  const { results: orgs } = await db
    .prepare(
      `SELECT o.id, o.name, o.domain, o.relationship_status,
              (SELECT COUNT(*) FROM contact c WHERE c.organization_id = o.id) AS contact_count,
              (SELECT COUNT(*) FROM engagement e WHERE e.organization_id = o.id) AS engagement_count,
              (SELECT COUNT(*) FROM contact c WHERE c.organization_id = o.id
                 AND c.email_work LIKE '%@%.%') AS emailed,
              (CASE WHEN o.domain IS NOT NULL AND o.domain <> '' THEN 1 ELSE 0 END
               + CASE WHEN o.industry IS NOT NULL AND o.industry <> '' THEN 1 ELSE 0 END
               + CASE WHEN o.address IS NOT NULL AND o.address <> '' THEN 1 ELSE 0 END
               + CASE WHEN o.notes IS NOT NULL AND o.notes <> '' THEN 1 ELSE 0 END
               + CASE WHEN o.calendar_tag IS NOT NULL AND o.calendar_tag <> '' THEN 1 ELSE 0 END) AS filled
         FROM organization o`
    )
    .all<Omit<OrgLite, "norm">>();

  const byId = new Map<number, OrgLite>();
  for (const o of orgs) byId.set(o.id, { ...o, norm: normalizeName(o.name) });

  // Already judged. Read once, into a set, so the filter below costs nothing per pair.
  const { results: judged } = await db
    .prepare("SELECT a_id, b_id FROM organization_not_duplicate")
    .all<{ a_id: number; b_id: number }>();
  const settled = new Set(judged.map((j) => key(j.a_id, j.b_id)));

  const found = new Map<string, Candidate>();
  /**
   * First writer wins, so a pair offered by rule 1 keeps rule 1's reason rather than rule 4's.
   *
   * `people` is keyed by ORGANIZATION ID, not by side, because the caller does not know which of its two
   * ids will sort lower — and getting that backwards would print the wrong person against the wrong
   * company, which is worse than printing none.
   */
  const offer = (
    aId: number,
    bId: number,
    strength: number,
    reason: string,
    people?: Map<number, Culprit[]>
  ) => {
    if (aId === bId) return;
    const k = key(aId, bId);
    if (settled.has(k) || found.has(k)) return;
    const a = byId.get(Math.min(aId, bId));
    const b = byId.get(Math.max(aId, bId));
    if (!a || !b) return;
    found.set(k, {
      a,
      b,
      strength,
      reason,
      aPeople: people?.get(a.id) ?? [],
      bPeople: people?.get(b.id) ?? [],
    });
  };

  // ---- rule 1: a shared email domain among the contacts, or on the organizations themselves
  /*
   * PER CONTACT, not grouped by company. The first version grouped, which is why the screen could only
   * say "people at both use this domain" and then link to everybody — see the note on Candidate.aPeople.
   * One row per contact costs nothing extra here (the query already scanned them) and is the difference
   * between a pair you decide in five seconds and one you decide by reading 63 names.
   */
  const { results: domainRows } = await db
    .prepare(
      `SELECT c.id, c.full_name AS name, c.email_work AS email, c.organization_id AS org,
              lower(substr(c.email_work, instr(c.email_work,'@') + 1)) AS dom
         FROM contact c
        WHERE c.organization_id IS NOT NULL AND c.email_work LIKE '%@%.%'
        ORDER BY c.full_name`
    )
    .all<{ id: number; name: string; email: string; org: number; dom: string }>();

  /*
   * Free and shared providers are excluded. Without this, every organization holding one contact with a
   * gmail address would be a candidate against every other — thousands of pairs, all worthless, and the
   * queue would be unusable on its first load. Not exhaustive, and does not need to be: a provider that
   * slips through produces a visibly silly reason line rather than a wrong merge.
   */
  const FREE = new Set([
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com",
    "msn.com", "live.com", "comcast.net", "sbcglobal.net", "att.net", "verizon.net", "protonmail.com",
    "mac.com", "ymail.com", "bellsouth.net", "cox.net", "charter.net", "earthlink.net",
  ]);

  /*
   * domain → company id → the contacts at that company carrying it. Two levels rather than one, because
   * the queue has to be able to name the person, not just the company.
   */
  const byDomain = new Map<string, Map<number, Culprit[]>>();
  const normDomain = (dom: string | null): string | null => {
    if (!dom) return null;
    const d = dom.trim().toLowerCase().replace(/^www\./, "");
    return !d || FREE.has(d) || !d.includes(".") ? null : d;
  };
  const addDomain = (dom: string | null, org: number | null, who: Culprit | null) => {
    const d = normDomain(dom);
    if (!d || !org) return;
    if (!byDomain.has(d)) byDomain.set(d, new Map());
    const orgs = byDomain.get(d)!;
    if (!orgs.has(org)) orgs.set(org, []);
    if (who) orgs.get(org)!.push(who);
  };
  for (const r of domainRows) addDomain(r.dom, r.org, { id: r.id, name: r.name, email: r.email });
  /*
   * The company's OWN `domain` field counts too, with no person attached — nobody is at fault when the
   * match comes from a field typed directly on the company record itself.
   */
  for (const o of byId.values()) addDomain(o.domain, o.id, null);

  for (const [dom, orgs] of byDomain) {
    if (orgs.size < 2) continue;
    /*
     * A domain shared by a great many organizations is not evidence of anything — it is a consultancy's
     * client domain, a typo pattern, or a provider this code has not heard of. Same reasoning as
     * TOKEN_MAX_ORGS, applied to domains.
     */
    if (orgs.size > TOKEN_MAX_ORGS) continue;
    const list = [...orgs.keys()];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        offer(list[i], list[j], 1, `the email domain ${dom} appears at both`, orgs);
  }

  // ---- rule 2: the same name once punctuation and legal form are removed
  const byNorm = new Map<string, number[]>();
  for (const o of byId.values()) {
    if (!o.norm) continue;
    if (!byNorm.has(o.norm)) byNorm.set(o.norm, []);
    byNorm.get(o.norm)!.push(o.id);
  }
  for (const [norm, ids] of byNorm) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        offer(ids[i], ids[j], 2, `the same name once punctuation and Inc/LLC are ignored — “${norm}”`);
  }

  // ---- rules 3 and 4, both driven off the distinctive-word index
  const byToken = new Map<string, number[]>();
  for (const o of byId.values())
    for (const t of new Set(tokensOf(o.norm))) {
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t)!.push(o.id);
    }

  for (const [token, ids] of byToken) {
    // The cap that makes this tractable — see TOKEN_MAX_ORGS.
    if (ids.length < 2 || ids.length > TOKEN_MAX_ORGS) continue;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = byId.get(ids[i])!;
        const b = byId.get(ids[j])!;
        const [shorter, longer] = a.norm.length <= b.norm.length ? [a.norm, b.norm] : [b.norm, a.norm];

        // rule 3 — containment, on whole words so "acme" does not match "acmex"
        if (longer === shorter || longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`) || longer.includes(` ${shorter} `)) {
          offer(a.id, b.id, 3, `one name contains the other — “${shorter}” inside “${longer}”`);
          continue;
        }

        // rule 4 — the distinctive word plus a near-miss elsewhere
        const d = editDistance(a.norm, b.norm);
        if (d <= 2) {
          offer(a.id, b.id, 4, `differ by ${d} character${d === 1 ? "" : "s"}, and both contain “${token}”`);
          continue;
        }
        const aw = new Set(a.norm.split(" "));
        const bw = new Set(b.norm.split(" "));
        const shared = [...aw].filter((w) => bw.has(w));
        if (shared.length && shared.length >= Math.min(aw.size, bw.size)) {
          offer(a.id, b.id, 4, `every distinguishing word of one appears in the other — “${shared.join(" ")}”`);
        }
      }
  }

  const rows = [...found.values()].sort(
    (x, y) =>
      x.strength - y.strength ||
      y.a.contact_count + y.b.contact_count - (x.a.contact_count + x.b.contact_count) ||
      x.a.name.localeCompare(y.a.name)
  );
  return { rows: rows.slice(0, limit), total: rows.length };
}

// ---------------------------------------------------------------- the queue

const STRENGTH_PILL = ["", "green", "green", "", "amber"];

/**
 * The name as it appears ON A BUTTON, which is not the same job as the name in the list above it.
 *
 * `Keep "Example Industries Tax Advisory, LLC"` renders a 340px button, and two of those side by side wrap
 * onto separate lines on a phone and read like two unrelated actions. The full name is directly above in
 * the pair itself and repeated in the button's title, so truncating here loses nothing — measured at
 * 390px, where the untruncated version was the widest element on the page.
 */
function shortName(n: string): string {
  return n.length <= 26 ? n : `${n.slice(0, 25).trimEnd()}…`;
}

app.get("/organizations/duplicates", async (c) => {
  const { rows, total } = await candidates(c.env.DB);
  const settledCount = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM organization_not_duplicate")
    .first<{ n: number }>()
    .catch(() => null);

  /*
   * THE PEOPLE WHO CAUSED IT, not the people who work there.
   *
   * Listing every contact at both companies is unhelpful when only one or two people actually caused the
   * domain match — at a company with dozens of contacts, asking the reviewer to scan the whole list to
   * find the one causing the conflict defeats the purpose of a review queue.
   *
   * So a domain match names the individuals whose own address produced it, with the address, each linking
   * to their record. `see the people` survives only as a secondary link and only when there is nobody
   * specific to blame — which is every name-based pair, where the whole company matched.
   */
  const CULPRIT_LIMIT = 8;

  /**
   * Is this domain NORMAL at this company, or is it the exception?
   *
   * THIS IS THE WHOLE POINT OF THE SECOND PASS. Naming the matching people was necessary but not
   * sufficient: a domain can be the clear majority pattern at one company — simply its own email domain —
   * while only a small minority of contacts at the other company happen to share it. Listing every name on
   * the majority side alongside the few on the minority side buries the actual finding in the evidence.
   *
   * So the majority side is summarised in a sentence and the minority side is named person by person.
   * Half is the threshold, and the denominator is contacts WITH a work email — a company where most
   * contacts have no email recorded would otherwise look like an exception on every domain.
   */
  const isHomeDomain = (matched: number, emailed: number) =>
    matched > 0 && emailed > 0 && matched * 2 >= emailed;

  const culprits = (people: Culprit[], o: Candidate["a"]) => {
    const all = `<a href="/contacts?org=${encodeURIComponent(o.name)}">all ${o.contact_count} ${
      o.contact_count === 1 ? "person" : "people"
    } here</a>`;

    // No domain match on this side at all — nobody to name, so just the way in.
    if (!people.length)
      return o.contact_count ? `<div class="meta">${all}</div>` : "";

    if (isHomeDomain(people.length, o.emailed)) {
      const whole = people.length === o.emailed;
      const phrase = !whole
        ? "most emailed contacts here use it"
        : o.emailed === 1
          ? "the only emailed contact here uses it"
          : o.emailed === 2
            ? "both emailed contacts here use it"
            : "every emailed contact here uses it";
      return `<div class="meta" style="margin-top:6px"><b>${people.length} of ${
        o.emailed
      }</b> — ${phrase}, so this looks like <b>${esc(o.name)}</b>’s own domain.</div>
      <div class="meta" style="margin-top:4px">${all}</div>`;
    }

    const shown = people.slice(0, CULPRIT_LIMIT);
    return `<div class="meta" style="margin-top:6px"><b>${people.length} of ${o.emailed}</b> — the exception${
      people.length === 1 ? "" : "s"
    } here, and the reason for this pair:</div>
      <ul class="rows" style="margin:2px 0 0">${shown
        .map(
          (w) =>
            `<li style="padding:2px 0"><a href="/contacts/${w.id}"><b>${esc(w.name)}</b></a> <span class="meta">${esc(
              w.email
            )}</span> · <a class="meta" href="/contacts/${w.id}/edit">fix</a></li>`
        )
        .join("")}${
      people.length > shown.length
        ? `<li style="padding:2px 0" class="meta">…and ${people.length - shown.length} more</li>`
        : ""
    }</ul>
      <div class="meta" style="margin-top:4px">${all}</div>`;
  };

  const side = (o: Candidate["a"], people: Culprit[]) => `<div>
      <a href="/organizations/${o.id}/edit"><b>${esc(o.name)}</b></a>
      ${
        o.relationship_status
          ? ` <span class="pill grey">${esc(labelFor(ORG_RELATIONSHIP, o.relationship_status))}</span>`
          : ""
      }
      <div class="meta">${o.contact_count} ${o.contact_count === 1 ? "person" : "people"} · ${
        o.engagement_count
      } engagement${o.engagement_count === 1 ? "" : "s"} · ${
        o.filled ? `${o.filled} field${o.filled === 1 ? "" : "s"} filled in` : "nothing filled in"
      }</div>
      ${o.domain ? `<div class="meta">company domain: ${esc(o.domain)}</div>` : ""}
      ${culprits(people, o)}
    </div>`;

  /**
   * The odd side of a domain match: one company where the domain is normal, one where it is not.
   *
   * When that shape holds, the honest reading is usually NOT that two companies are one — it is that a
   * handful of contacts are filed under the wrong employer, carrying an email address that belongs to a
   * different company than the one recorded on their contact record. Merging the two companies over that
   * would be a large, wrong, silent change, so the screen says so before it offers either merge button.
   */
  const misfiled = (p: Candidate) => {
    if (p.strength !== 1) return null;
    const aHome = isHomeDomain(p.aPeople.length, p.a.emailed);
    const bHome = isHomeDomain(p.bPeople.length, p.b.emailed);
    if (aHome === bHome) return null;
    const odd = aHome ? { org: p.b, people: p.bPeople } : { org: p.a, people: p.aPeople };
    const home = aHome ? p.a : p.b;
    if (!odd.people.length || odd.people.length > 3) return null;
    return { odd, home };
  };

  const pairs = rows.length
    ? rows
        .map(
          (p) => {
            const odd = misfiled(p);
            const mergeStyle = odd ? "secondary" : "";
            const notDupeStyle = odd ? "" : "secondary";
            return `<section class="card">
    <p class="meta" style="margin:0 0 8px"><span class="pill ${STRENGTH_PILL[p.strength] || "grey"}">${
      p.strength <= 2 ? "strong match" : p.strength === 3 ? "likely" : "worth a look"
    }</span> ${esc(p.reason)}</p>
    <div class="row" style="align-items:flex-start">
      ${side(p.a, p.aPeople)}
      ${side(p.b, p.bPeople)}
    </div>
    ${(() => {
      const m = odd;
      if (!m) return "";
      const who = m.odd.people
        .map((w) => `<a href="/contacts/${w.id}/edit">${esc(w.name)}</a>`)
        .join(", ");
      return `<p class="meta" style="margin:0 0 10px;padding:8px 10px;background:#fffbeb;border-radius:8px"><b>This may not be a duplicate at all.</b> The domain is normal at <b>${esc(
        m.home.name
      )}</b>, and at <b>${esc(m.odd.org.name)}</b> only ${who} use${
        m.odd.people.length === 1 ? "s" : ""
      } it. If ${
        m.odd.people.length === 1 ? "that address is" : "those addresses are"
      } right and the company is wrong, fix the ${
        m.odd.people.length === 1 ? "person" : "people"
      } and mark this pair as not a duplicate — rather than merging two real companies together.</p>`;
    })()}
    <div class="actions">
      ${/*
        THE MERGE FORM NAMES WHICH ROW SURVIVES, because that is the only part of a merge that cannot be
        guessed. Two buttons rather than a dropdown plus a submit: the choice IS the action, and a
        two-step version invites merging into whichever row happened to be selected.
      */ ""}
      ${/*
        BUTTON WEIGHT FOLLOWS THE ADVICE. When the misfiled-contact shape is detected the screen has just
        argued against merging, so leaving two primary Keep buttons beside that paragraph would say one
        thing in prose and the opposite in colour. The recommended answer takes the primary style and the
        merges go quiet — neither is removed, because the reading can be wrong and the merge may still be
        right.
      */ ""}
      <form method="post" action="/organizations/merge">
        <input type="hidden" name="keep" value="${p.a.id}">
        <input type="hidden" name="drop" value="${p.b.id}">
        <button class="${mergeStyle}" type="submit" title="Keep “${esc(p.a.name)}” and move everything from “${esc(
          p.b.name
        )}” into it">Keep “${esc(shortName(p.a.name))}”</button>
      </form>
      <form method="post" action="/organizations/merge">
        <input type="hidden" name="keep" value="${p.b.id}">
        <input type="hidden" name="drop" value="${p.a.id}">
        <button class="${mergeStyle}" type="submit" title="Keep “${esc(p.b.name)}” and move everything from “${esc(
          p.a.name
        )}” into it">Keep “${esc(shortName(p.b.name))}”</button>
      </form>
      <form method="post" action="/organizations/not-duplicate">
        <input type="hidden" name="a" value="${p.a.id}">
        <input type="hidden" name="b" value="${p.b.id}">
        <input type="text" name="note" placeholder="why, if you like — e.g. separate practice" style="max-width:260px">
        <button class="${notDupeStyle}" type="submit">Not a duplicate</button>
      </form>
    </div>
  </section>`;
          }
        )
        .join("")
    : `<div class="card empty">
      <p><b>Nothing left to judge.</b></p>
      <p class="meta">Either no two companies look alike, or you have already decided about the ones that do.${
        settledCount?.n ? ` ${settledCount.n} pair${settledCount.n === 1 ? "" : "s"} marked as not duplicates.` : ""
      }</p>
    </div>`;

  return c.html(
    layout({
      title: "Possible Duplicates",
      body: `<main>
  ${
    { merged: '<div class="flash ok">Merged. Everything moved to the company you kept, and the audit trail says exactly what moved.</div>',
      notdupe: '<div class="flash ok">Noted. That pair will not be offered again — including after an import adds people to either one.</div>',
      samerow: '<div class="flash warn">That was the same company on both sides, so nothing happened.</div>',
      gone: '<div class="flash warn">One of those companies no longer exists — probably merged in another tab. The list below is current.</div>' }[
      c.req.query("flash") ?? ""
    ] ?? ""
  }
  <h1>Possible Duplicates</h1>
  <p class="sub">${total} pair${total === 1 ? "" : "s"} to judge${
    total > rows.length ? `, showing ${rows.length}` : ""
  }${settledCount?.n ? ` · ${settledCount.n} already marked not duplicates` : ""} · <a href="/organizations">all companies</a></p>

  <div class="card">
    <p style="margin:0 0 6px"><b>Nothing here merges on its own.</b> Every pair below is a suggestion with the reason it was suggested, and there are three answers: keep one and merge, mark them as different companies, or leave it and come back.</p>
    <p class="meta" style="margin:0">Marking a pair <b>not a duplicate</b> is permanent — it will not be offered again, including after an import adds contacts to either side. That is what makes this list something you can finish. Firms with legitimately separate entities (a multi-brand holding company, say) get marked once and stay marked.</p>
  </div>

  ${pairs}

  ${
    rows.length
      ? `<p class="meta">Merging moves every contact and engagement to the company you keep, copies across any field that is filled in on one side and blank on the other, and deletes the other row. <b>It cannot be undone from a screen</b> — the audit trail records both names and what moved, so it can be reversed by hand, but choose deliberately. Renaming instead is on <a href="/organizations">the company record</a>.</p>`
      : ""
  }
</main>`,
    })
  );
});

app.post("/organizations/not-duplicate", async (c) => {
  const f = await c.req.parseBody();
  const a = Number(f.a);
  const b = Number(f.b);
  if (!a || !b || a === b) return c.redirect("/organizations/duplicates?flash=samerow");
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const note = typeof f.note === "string" && f.note.trim() ? f.note.trim() : null;

  const names = await c.env.DB.prepare("SELECT id, name FROM organization WHERE id IN (?, ?)")
    .bind(lo, hi)
    .all<{ id: number; name: string }>();
  if (names.results.length < 2) return c.redirect("/organizations/duplicates?flash=gone");

  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO organization_not_duplicate (a_id, b_id, note) VALUES (?,?,?)"
  )
    .bind(lo, hi, note)
    .run();
  await c.env.DB.prepare(
    "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'organization',?,?,?,?,'app',?)"
  )
    .bind(
      ACTOR,
      String(lo),
      "not-duplicate",
      null,
      `${names.results.map((r) => r.name).join(" / ")} are different companies${note ? ` — ${note}` : ""}`,
      `organization-${lo}-${hi}`
    )
    .run();
  return c.redirect("/organizations/duplicates?flash=notdupe");
});

/**
 * The merge. Two re-points, a field fill, and a delete.
 *
 * ONLY TWO TABLES REFERENCE AN ORGANIZATION — `contact.organization_id` and
 * `engagement.organization_id`, verified against the live schema on 2026-09-02 rather than assumed. That
 * is what makes this cheap, and it is also what would make it wrong later: a third table pointing at
 * organization(id) must be added here, or its rows will be orphaned by a merge. The 0009 migration note
 * makes the same point about `contact` and got it wrong once already, which is why this is checked and
 * stated rather than remembered.
 *
 * NOT WRAPPED IN A TRANSACTION, and that is worth being honest about: D1 has no interactive transaction,
 * and `batch()` is one — so the four statements go through batch() together, all or nothing. A partial
 * merge would be the worst outcome here (contacts moved, engagements not, both rows still present), so it
 * is the one thing this route must not risk.
 */
app.post("/organizations/merge", async (c) => {
  const f = await c.req.parseBody();
  const keep = Number(f.keep);
  const drop = Number(f.drop);
  if (!keep || !drop || keep === drop) return c.redirect("/organizations/duplicates?flash=samerow");

  const { results: both } = await c.env.DB.prepare("SELECT * FROM organization WHERE id IN (?, ?)")
    .bind(keep, drop)
    .all<Record<string, string | number | null>>();
  if (both.length < 2) return c.redirect("/organizations/duplicates?flash=gone");
  const survivor = both.find((r) => Number(r.id) === keep)!;
  const doomed = both.find((r) => Number(r.id) === drop)!;

  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM contact WHERE organization_id = ?) AS contacts,
            (SELECT COUNT(*) FROM engagement WHERE organization_id = ?) AS engagements`
  )
    .bind(drop, drop)
    .first<{ contacts: number; engagements: number }>();

  /*
   * FILL BLANKS ONLY — never overwrite. The surviving row is the one the user chose to keep, so its own
   * values are the deliberate ones; the other row's are worth having only where the survivor has nothing.
   * A merge that silently replaced a value someone had typed with one from a row being discarded would be
   * the sort of quiet data change this codebase keeps trying to avoid.
   */
  const FILLABLE = ["domain", "industry", "address", "relationship_status", "calendar_tag"] as const;
  const filled: string[] = [];
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const col of FILLABLE) {
    const mine = survivor[col];
    const theirs = doomed[col];
    if ((mine === null || mine === "") && theirs !== null && theirs !== "") {
      sets.push(`${col} = ?`);
      vals.push(theirs);
      filled.push(col);
    }
  }
  // Notes are appended rather than filled, because two companies' notes are both true of the merged one.
  const myNotes = String(survivor.notes ?? "");
  const theirNotes = String(doomed.notes ?? "");
  if (theirNotes && theirNotes !== myNotes) {
    sets.push("notes = ?");
    vals.push(myNotes ? `${myNotes}\n\n[merged from ${doomed.name}] ${theirNotes}` : theirNotes);
    filled.push("notes");
  }

  const summary = `merged “${doomed.name}” (id ${drop}) into “${survivor.name}” (id ${keep}) — moved ${
    counts?.contacts ?? 0
  } contact${(counts?.contacts ?? 0) === 1 ? "" : "s"} and ${counts?.engagements ?? 0} engagement${
    (counts?.engagements ?? 0) === 1 ? "" : "s"
  }${filled.length ? `, filled ${filled.join(", ")} from the merged row` : ""}`;

  const statements = [
    c.env.DB.prepare("UPDATE contact SET organization_id = ?, updated_at = datetime('now') WHERE organization_id = ?").bind(keep, drop),
    c.env.DB.prepare("UPDATE engagement SET organization_id = ?, updated_at = datetime('now') WHERE organization_id = ?").bind(keep, drop),
    ...(sets.length
      ? [
          c.env.DB.prepare(
            `UPDATE organization SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`
          ).bind(...vals, keep),
        ]
      : []),
    /*
     * The disappearing row's "not a duplicate" judgements go with it rather than being repointed — see
     * migration 0023's header. "A is not B" says nothing about the survivor of a B/C merge.
     */
    c.env.DB.prepare("DELETE FROM organization_not_duplicate WHERE a_id = ? OR b_id = ?").bind(drop, drop),
    c.env.DB.prepare("DELETE FROM organization WHERE id = ?").bind(drop),
    c.env.DB.prepare(
      "INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id) VALUES (?,'organization',?,?,?,?,'app',?)"
    ).bind(ACTOR, String(keep), "merge", String(doomed.name), summary, `organization-merge-${drop}`),
  ];

  await c.env.DB.batch(statements);
  return c.redirect("/organizations/duplicates?flash=merged");
});

export default app;
