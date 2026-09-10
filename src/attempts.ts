/*
 * What counts as an outreach attempt — one definition, shared by everything that asks (#82).
 *
 * THE BUG THIS EXISTS TO PREVENT. An outbound email was recorded on the Record an Interaction form, and
 * the chase list said "no attempt recorded" — on a row that, one line further along, said "1 attempt ·
 * tried email". One row, two contradictory facts, because the row drew them from two different places:
 *
 *   - the silence pill read `contact.last_attempt_at`, a stored column maintained ONLY by
 *     POST /escalation/:id/attempt (the chase buttons), and
 *   - the attempt count was DERIVED in chaseList() by counting attempt-type interactions.
 *
 * Anything recorded through the interaction form moved the derived number and left the stored column
 * untouched, so it was invisible to the ladder: a contact who had just been emailed could sort to the
 * very top of the chase list, above people who genuinely had never been contacted.
 *
 * The fix is not "also write the column over there". It is to state the definition once, here, and have
 * the write side (contacts.ts, escalation.ts), the read side (escalation.ts chaseList) and the drift
 * check below all use this one. Two implementations of the same idea is what produced the split.
 *
 * WHAT AN ATTEMPT IS
 * ------------------
 * An interaction whose type is a reachable channel — email, linkedin, text, call — and whose direction
 * is not inbound. Migration 0008's backfill already used the type half of this ("last_attempt_at is set
 * from the most recent attempt-type interaction (email, linkedin, text, call)"), so the channel list is
 * settled and this only adds the direction half.
 *
 * WHY NOT `direction = 'outbound'`, WHICH IS WHAT #82 ASKED FOR
 * ------------------------------------------------------------
 * Because the live data says that would miss real attempts, and would leave the two facts still able to
 * disagree on the same row. Two reasons, in order of how much they matter:
 *
 *   1. THE FORM DEFAULTS TO TWO-WAY. `interactionForm()` renders Direction with "two_way" preselected,
 *      so the value on a row records whatever the operator left it as, not a considered claim about who
 *      initiated. Real usage bears this out: plenty of texts and emails end up marked two_way even
 *      though their summary describes a one-sided outreach ("sent a text", "sent another email"). Those
 *      are outreach. An outbound-only rule records nothing for them, which is the same silence #82 is
 *      about.
 *   2. THE DERIVED COUNT NEVER FILTERED ON DIRECTION AT ALL. If the stored column counted outbound only
 *      while the count on the same row counted every direction, the two would still contradict each
 *      other — a narrower version of the identical bug.
 *
 * So the rule excludes only what is genuinely not an attempt: an interaction explicitly marked inbound.
 * A NULL direction counts, matching 0008, which had no direction filter to inherit.
 *
 * Applying this to the existing derived count changes no displayed number today: prod has no inbound
 * interaction of an attempt type as of this writing. The clause is there for tomorrow.
 *
 * WHAT AN ATTEMPT IS NOT: a meeting or a note, neither of which is a chase, and neither of which has
 * ever counted here.
 */

import type { D1Db } from "./types";

/**
 * The channels an outreach attempt can use. Also the set the chase buttons accept — escalation.ts
 * derives VALID_CHANNELS from this so a channel can never be recordable in one place and uncounted in
 * the other.
 */
export const ATTEMPT_TYPES = ["email", "linkedin", "text", "call"] as const;

/**
 * The same rule as SQL, for the queries that have to ask it of many rows at once.
 *
 * Requires the interaction table to be aliased `i`. Inlined as a fragment rather than parameterised
 * because it is composed into correlated subqueries in three different statements; the values are
 * literals from ATTEMPT_TYPES, not input, so there is nothing here to bind.
 */
export const ATTEMPT_SQL = `i.type IN (${ATTEMPT_TYPES.map((t) => `'${t}'`).join(",")})
       AND (i.direction IS NULL OR i.direction <> 'inbound')`;

/**
 * The rule as TypeScript, for the write side, which knows the one interaction it just recorded.
 *
 * Kept beside ATTEMPT_SQL on purpose: if these two ever say different things, the stored column and the
 * count on screen go back to disagreeing, which is exactly the failure this file is named after.
 */
export function isAttempt(type: string | null | undefined, direction: string | null | undefined): boolean {
  if (!type || !(ATTEMPT_TYPES as readonly string[]).includes(type)) return false;
  return direction !== "inbound";
}

/**
 * Bring a contact's escalation ladder back in line with their interaction history — FORWARD ONLY.
 *
 * WHY THIS EXISTS (REL-035, 2026-08-26). Recording an interaction maintained the ladder; EDITING one did
 * not. Moving an interaction's date forward left `last_attempt_at` pointing at the old, earlier date —
 * so the chase list would have called a contact fifteen days silent on the morning they were emailed,
 * which is the one thing that list exists to get right.
 *
 * The old comment on the edit path defended not doing this, citing #57 and #82, and it was right about
 * the danger it named: a correction to old history must not silently reorder the worklist. But it also
 * claimed the health check "only flags the opposite direction — history ahead of the ladder — for this
 * reason". Moving a date forward produces exactly that state, so the decision was manufacturing the
 * condition its own guard reports as a problem. One of the two had to change.
 *
 * FORWARD ONLY is what makes this safe, and it is the whole of the design:
 *
 *   - `last_attempt_at` moves later, never earlier. Editing a date backwards leaves it alone.
 *   - `escalation_rung` rises, never falls. Turning a note into an email adds the rung that outreach
 *     earned; turning an email back into a note does NOT take it away.
 *
 * So this can only ever say "you reached out more recently, or more often, than the ladder thought". It
 * cannot erase evidence of outreach, and it cannot make a contact look more neglected than they are —
 * which is the direction that would actually mislead. The rung is still not derived state: the dashboard
 * chase buttons raise it without creating an interaction at all, and a plain recompute would wipe those
 * out. That is why this raises a floor rather than recalculating a value.
 */
export async function reconcileAttemptLadder(db: D1Db, contactId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE contact SET
         escalation_rung = MAX(escalation_rung,
           (SELECT COUNT(*) FROM interaction i WHERE i.contact_id = ? AND ${ATTEMPT_SQL})),
         last_attempt_at = CASE
           WHEN (SELECT MAX(i.date) FROM interaction i WHERE i.contact_id = ? AND ${ATTEMPT_SQL})
                > COALESCE(last_attempt_at, '')
           THEN (SELECT MAX(i.date) FROM interaction i WHERE i.contact_id = ? AND ${ATTEMPT_SQL})
           ELSE last_attempt_at END,
         updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(contactId, contactId, contactId, contactId)
    .run();
}

export interface AttemptDrift {
  state: "ok" | "warn";
  message: string;
  /** Active contacts whose recorded attempt history is behind the interactions on file. */
  behind: { id: number; full_name: string; stored: number; derived: number; last_attempt_at: string | null; derived_last: string | null }[];
}

/**
 * The guard (#82, last item). Asks the one question that was true for 40 contacts before this was
 * fixed: is there an attempt in the interaction history that the ladder never recorded?
 *
 * DELIBERATELY ONE-DIRECTIONAL. It flags derived-ahead-of-stored and says nothing about the reverse,
 * because the reverse is a decision rather than a fault: #57 stored these values precisely so that
 * editing or deleting an old interaction cannot silently reorder the worklist. A deleted interaction
 * leaving the rung one ahead of the count is that decision working. Flagging it would train the health
 * page to be ignored, and a check that cries wolf about correct behaviour is worse than no check —
 * REL-022 earns its banner by only lighting up when something is genuinely broken.
 *
 * Names up to three contacts. The count carries the scale; the names make it actionable without turning
 * the health page into a report.
 */
export async function attemptDrift(db: D1Db): Promise<AttemptDrift> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.full_name, c.escalation_rung AS stored, c.last_attempt_at,
          (SELECT COUNT(*) FROM interaction i WHERE i.contact_id = c.id AND ${ATTEMPT_SQL}) AS derived,
          (SELECT MAX(i.date) FROM interaction i WHERE i.contact_id = c.id AND ${ATTEMPT_SQL}) AS derived_last
        FROM contact c
        WHERE c.status = 'active'
          AND ((SELECT COUNT(*) FROM interaction i WHERE i.contact_id = c.id AND ${ATTEMPT_SQL}) > c.escalation_rung
            OR (SELECT MAX(i.date) FROM interaction i WHERE i.contact_id = c.id AND ${ATTEMPT_SQL})
                 > COALESCE(c.last_attempt_at, ''))
        ORDER BY c.full_name`
    )
    .all<AttemptDrift["behind"][number]>();

  if (!results.length)
    return {
      state: "ok",
      message:
        "Every recorded outreach is counted on the escalation ladder — no contact has an attempt in their history that the chase list cannot see.",
      behind: [],
    };

  const names = results.slice(0, 3).map((r) => r.full_name);
  const more = results.length - names.length;
  return {
    state: "warn",
    message: `${results.length} contact${results.length === 1 ? " has an attempt" : "s have attempts"} in their interaction history that the escalation ladder has not recorded (${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}). The chase list will understate how often ${results.length === 1 ? "they have" : "they have each"} been contacted, and may show "no attempt recorded" for someone you have already reached out to.`,
    behind: results,
  };
}
