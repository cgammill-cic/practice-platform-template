// Interaction history rendering — compact, expandable entries so a contact with 20+ touches stays
// readable (feedback 2026-07-30). Uses native <details>/<summary>: no JavaScript, works everywhere,
// and each entry's one-line overview carries the date, type, subject, and the follow-up it set.

import { DIRECTIONS, INTERACTION_TYPES, MEETING_FORMATS, labelFor, stageLabel, type Interaction } from "./types";
import { esc } from "./views";

/** One-line overview + expandable detail for a single interaction, with an edit link. */
export function historyEntry(i: Interaction): string {
  const followUp = i.next_follow_up_set
    ? `<span class="pill">next: ${esc(i.next_follow_up_set)}</span>`
    : "";
  const staged = i.stage_moved_to
    ? `<span class="pill grey">→ ${esc(stageLabel(i.stage_moved_to))}</span>`
    : "";
  const overview = `<span class="hist-date">${esc(i.date)}</span>
    <span class="pill">${esc(labelFor(INTERACTION_TYPES, i.type))}</span>
    ${/* Format sits next to type because it qualifies it — "Meeting · Coffee" reads as one fact (0014).
         Grey rather than accent-coloured: it is descriptive, not a state anything acts on. */ ""}
    ${i.format ? `<span class="pill grey">${esc(labelFor(MEETING_FORMATS, i.format))}</span>` : ""}
    <span class="hist-subject">${esc(i.subject ?? (i.summary ? i.summary.slice(0, 60) + (i.summary.length > 60 ? "…" : "") : "—"))}</span>
    ${followUp} ${staged}`;

  // Every entry is expandable — even a bare one — so the edit link is always reachable.
  return `<details class="hist-row">
    <summary>${overview}</summary>
    <div class="hist-detail">
      ${i.direction ? `<div class="meta">${esc(labelFor(DIRECTIONS, i.direction))}</div>` : ""}
      ${i.summary ? `<div style="white-space:pre-wrap">${esc(i.summary)}</div>` : ""}
      ${i.outcome ? `<div class="meta">Outcome: ${esc(i.outcome)}</div>` : ""}
      ${i.notes_link ? `<div><a href="${esc(i.notes_link)}" target="_blank" rel="noopener">Full Notes ↗</a></div>` : ""}
      <div><a href="/interactions/${i.id}/edit">Edit This Interaction</a></div>
    </div>
  </details>`;
}

/**
 * History block for the contact record: the most recent interactions only (default 5). Everything
 * older lives on the full history page — the contact record stays a snapshot, not an archive.
 *
 * @param recent   the newest interactions, already limited by the caller's query
 * @param total    true count of all interactions for this contact (may exceed recent.length)
 */
export function historyBlock(contactId: number, recent: Interaction[], total: number): string {
  if (!recent.length) return '<div class="empty">No interactions recorded yet.</div>';
  const hidden = total - recent.length;
  return `<div class="hist">${recent.map(historyEntry).join("")}</div>
  <p class="meta" style="margin-top:10px">
    <a href="/contacts/${contactId}/history">Open Full History →</a>${
      hidden > 0 ? ` <span>(${hidden} older interaction${hidden === 1 ? "" : "s"} not shown)</span>` : ""
    }
  </p>`;
}
