// Bulk field updates from a file (REL-033, 2026-08-21).
//
// THE PROBLEM. The operator curates offline. Which contacts are Retired or Not Qualified, and what
// priority each deserves, gets decided in a spreadsheet — and there was no way to get those decisions
// back in. The recurring request, paraphrased: "I've done updates offline to change the priority and
// even the stage of some contacts — is there a way to bring that back into the app?"
//
// WHY THIS IS NOT PART OF THE IMPORTER. /import is insert-only on purpose: it matches every row
// against current state and SKIPS what it finds, which is the guarantee that a re-run cannot damage
// a curated record. Teaching it to write over existing rows would delete that guarantee for every
// file, including the ones meant purely to add people. So updates get their own route, their own
// screen, and their own verb. A file that adds contacts and a file that overwrites them should not
// look alike, because the cost of confusing them is asymmetric: a missed insert is an absence you
// will notice, and a wrong overwrite is a silent loss of something you curated.
//
// MATCHING IS BY id ONLY, chosen 2026-08-21 over name/email fallbacks. The id comes from
// /export/contacts.csv, so an update file is always born from current state rather than a stale copy,
// and there is no chance of a name collision writing to the wrong person — production has already
// produced real evidence that names are not keys, more than once. The cost is that a hand-built file
// without ids cannot be used, which is the right trade: the export is one click.
//
// FOUR FIELDS ARE WRITABLE: stage, priority_tier, strength, status — the middle of three options that
// were considered. These are the judgment fields — what the operator decides ABOUT a contact. Names, employers,
// phones and every date are deliberately NOT writable here, so a spreadsheet autocorrect or a
// phone number that Excel helpfully turned into a float cannot reach production through this door.
// Identity and history change one record at a time, on the record.
//
// EMAIL JOINED THE LIST 2026-09-08, and it is the one exception to "identity changes one record at a
// time" above — not a reversal of that rule, but a case the rule never actually covered. An attempt to
// correct a batch of stale emails through /import ran into the fact that it has no update path at all: a
// matched row is only ever SKIPPED, never written, and the changed emails could never match anything
// (they were new values by definition), so the name+organization fallback was all that stood between
// each row and a fresh insert. Most rows had a blank or mismatched organization column and became
// duplicate contacts; the one row that WOULD have matched by name+org was correctly skipped and so its
// email was never written either — /import cannot update ANY matched row, which is not a bug in the
// matcher, it is the route's whole design. Cleaning up the resulting duplicates by hand is what surfaced
// this gap.
//
// The id-matching guarantee above makes email exactly as safe here as stage or priority_tier — there is
// no name collision to get wrong, because there is no name involved. What makes email different from a
// phone number or an address is that duplicate detection elsewhere in the app (/import, /email/import)
// keys off it, so a wrong email written here is not just wrong contact data, it can cause a FUTURE
// mismatch of its own. Written the same as every other field: blank means leave alone, and a value that
// does not look like an address (no "@", contains whitespace) blocks the row rather than writing garbage.
//
// A MISSING COLUMN AND A BLANK CELL BOTH MEAN "LEAVE IT ALONE". A blank cell in a full export must not
// wipe the field it sits under — on a 4,000-row file that would be a mass deletion dressed as a no-op.
// Clearing a field is therefore impossible here and stays a per-record edit. Stated on the form, because
// a rule that silently ignores input has to be visible or it reads as a bug.

import { Hono } from "hono";
import { parseCsv } from "./importer";
import { esc, layout } from "./views";
import {
  MAX_PRIORITY_TIER,
  STAGES,
  STATUSES,
  STRENGTHS,
  stageLabel,
  type Bindings,
  type D1Db,
} from "./types";

const app = new Hono<{ Bindings: Bindings }>();

const ACTOR = "operator";

/** How many UPDATE statements go in one D1 batch. See the commit handler. */
const BATCH_SIZE = 50;

/**
 * The stage-event origin written for changes made through this route, and the reason it exists.
 *
 * A bulk sweep is RECLASSIFICATION, not relationship movement. When the operator marks hundreds of
 * people Retired because they worked through a spreadsheet, nothing happened between them and those
 * people — the record caught up with what was already true. /pipeline exists to answer "where are
 * relationships going", and hundreds of arrivals into Retired in one second would swamp every real
 * signal on the page.
 *
 * So the event is still WRITTEN — the history must not lie about the record having changed — and it is
 * excluded from the movement counts, the same way same-stage saves already are. This is the second
 * time this exact trap has come up (2026-08-20, correcting a large batch of imported stages), which is
 * why the exclusion now lives in pipeline.ts as a named rule rather than being cleaned up after the fact.
 *
 * The consequence to be honest about: a stage change made through a file will never appear in the
 * movement report, even if a real conversation caused it. Real movement goes through the contact
 * record, one person at a time. Stated on the preview so the choice is visible before the operator
 * commits.
 */
const BULK_ORIGIN = "bulk-update";

const FIELDS = ["stage", "priority_tier", "strength", "status", "email_work", "email_personal"] as const;
type Field = (typeof FIELDS)[number];

// Widened to Set<string> deliberately: these are checked against arbitrary spreadsheet text, so the
// membership test is the thing that PROVES the value is legal. A Set of the literal union would make
// `.has(userInput)` a type error and invite a cast, which would move the check from the type system
// into a comment.
const STAGE_VALUES: Set<string> = new Set(STAGES.map(([v]) => v));
const STRENGTH_VALUES: Set<string> = new Set(STRENGTHS.map(([v]) => v));
const STATUS_VALUES: Set<string> = new Set(STATUSES.map(([v]) => v));

const LABELS: Record<Field, string> = {
  stage: "Stage",
  priority_tier: "Priority Tier",
  strength: "Strength",
  status: "Status",
  email_work: "Work Email",
  email_personal: "Personal Email",
};

/** Same rule as the importer's email() cleaner — an address has an "@" and no spaces. */
const EMAIL_FIELDS: Set<Field> = new Set(["email_work", "email_personal"]);
const looksLikeEmail = (v: string): boolean => v.includes("@") && !v.includes(" ");

/** Every column the file may carry, for the on-screen guidance. */
const RECOGNIZED = ["id", ...FIELDS] as const;

interface Current {
  id: number;
  full_name: string;
  organization: string | null;
  stage: string;
  priority_tier: number | null;
  strength: string | null;
  status: string;
  email_work: string | null;
  email_personal: string | null;
}

interface Change {
  field: Field;
  from: string | null;
  to: string;
}

interface StagedUpdate {
  row: number;
  id: number | null;
  raw: Record<string, string>;
  current: Current | null;
  changes: Change[];
  errors: string[];
}

const clean = (v: string | undefined): string => (v ?? "").trim();

/** Human display for a stored value, so the preview reads in plain words rather than the column's. */
function show(field: Field, value: string | number | null): string {
  if (value === null || value === "") return "not set";
  const v = String(value);
  if (field === "stage") return stageLabel(v);
  if (field === "strength") return STRENGTHS.find(([k]) => k === v)?.[1] ?? v;
  if (field === "status") return STATUSES.find(([k]) => k === v)?.[1] ?? v;
  return v;
}

/**
 * Normalize and validate one submitted value. Accepts the stored key ("not_qualified") and the label
 * ("Not Qualified"), case-insensitively, because the export emits both `stage` and `stage_label` and
 * whichever column he happens to edit should work. Returns null when the value is not recognized —
 * the caller turns that into a blocking error rather than guessing, since guessing a stage wrong is
 * exactly the failure this whole feature is repairing.
 */
function normalize(field: Field, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const key = v.toLowerCase().replace(/[\s-]+/g, "_");

  if (field === "priority_tier") {
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return n >= 1 && n <= MAX_PRIORITY_TIER ? String(n) : null;
  }
  if (field === "stage") {
    if (STAGE_VALUES.has(key)) return key;
    const byLabel = STAGES.find(([, label]) => label.toLowerCase() === v.toLowerCase());
    return byLabel ? byLabel[0] : null;
  }
  if (field === "strength") return STRENGTH_VALUES.has(key) ? key : null;
  if (field === "status") return STATUS_VALUES.has(key) ? key : null;
  // email_work / email_personal. Lowercased on the way in — the same normalization the importer and
  // every other write path apply — so a value typed in a different case never reads as a change from
  // what is already stored, and never creates a second, case-varied duplicate key elsewhere.
  return looksLikeEmail(v) ? v.toLowerCase() : null;
}

function currentValue(cur: Current, field: Field): string | null {
  const v = cur[field];
  if (v === null || v === undefined) return null;
  // Lowercased for email so a value stored in another case (e.g. typed on the contact edit page) never
  // reads as "changed" when the file offers the same address in a different case.
  return EMAIL_FIELDS.has(field) ? String(v).toLowerCase() : String(v);
}

/**
 * Turn one CSV line into a staged update. `header` is used to distinguish "column absent from the
 * file" from "cell left blank" — both mean leave-alone, so the distinction does not change behaviour,
 * but it does change what the preview can honestly say about a row.
 */
export function stageUpdate(
  rec: Record<string, string>,
  rowNumber: number,
  present: Set<string>
): Omit<StagedUpdate, "current" | "changes"> & { wanted: Partial<Record<Field, string>> } {
  const errors: string[] = [];
  const idRaw = clean(rec.id);
  let id: number | null = null;
  if (!idRaw) errors.push("no id — every row must carry the id from the export");
  else if (!/^\d+$/.test(idRaw)) errors.push(`id "${idRaw}" is not a number`);
  else id = Number(idRaw);

  const wanted: Partial<Record<Field, string>> = {};
  for (const f of FIELDS) {
    if (!present.has(f)) continue;
    const raw = clean(rec[f]);
    if (!raw) continue;
    const norm = normalize(f, raw);
    if (norm === null) {
      errors.push(
        f === "priority_tier"
          ? `priority_tier "${raw}" is not a whole number between 1 and ${MAX_PRIORITY_TIER}`
          : EMAIL_FIELDS.has(f)
            ? `${LABELS[f]} "${raw}" does not look like an email address`
            : `${f} "${raw}" is not a recognized ${LABELS[f].toLowerCase()}`
      );
      continue;
    }
    wanted[f] = norm;
  }

  if (!errors.length && Object.keys(wanted).length === 0 && [...present].some((p) => FIELDS.includes(p as Field)))
    errors.push("nothing to change — every writable cell on this row is blank");

  return { row: rowNumber, id, raw: rec, errors, wanted };
}

/** One query for every contact the file names, rather than one per row (the 2026-08-20 lesson). */
async function loadCurrent(db: D1Db, ids: number[]): Promise<Map<number, Current>> {
  const out = new Map<number, Current>();
  if (!ids.length) return out;
  const unique = [...new Set(ids)];
  // Chunked because SQLite caps bound parameters per statement; 90 keeps well inside it.
  for (let i = 0; i < unique.length; i += 90) {
    const slice = unique.slice(i, i + 90);
    const { results } = await db
      .prepare(
        `SELECT c.id, c.full_name, o.name AS organization, c.stage, c.priority_tier, c.strength, c.status,
                c.email_work, c.email_personal
           FROM contact c LEFT JOIN organization o ON o.id = c.organization_id
          WHERE c.id IN (${slice.map(() => "?").join(",")})`
      )
      .bind(...slice)
      .all<Current>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

// ---------------------------------------------------------------- form

app.get("/update", (c) =>
  c.html(
    layout({
      title: "Update Contacts from a File",
      body: `<main>
  <h1>Update Contacts from a File</h1>
  <p class="sub">For changes you made offline. Nothing is written until you review the preview and confirm.</p>
  <p class="phone-only flash warn" style="margin-bottom:14px">This is desk work. It runs on a phone, but the preview you are meant to check before writing is a wide table — do this one on a computer if you can.</p>

  <form class="card" method="post" action="/update/preview" enctype="multipart/form-data">
    <label>CSV file</label>
    <input type="file" name="file" accept=".csv,text/csv" required>
    <p class="meta" style="margin-top:10px">Recognized columns — any others are ignored:<br>
      <code>${RECOGNIZED.join(", ")}</code></p>
    <div class="actions"><button type="submit">Read File and Preview</button></div>
  </form>

  <section>
    <h2>Start from an export</h2>
    <p class="meta" style="margin:0 0 8px">Rows are matched on <code>id</code>, so the file has to come from
      <a href="/export">Export</a> — <code>/export/contacts.csv</code> already carries <code>id</code>,
      <code>stage</code>, <code>priority_tier</code>, <code>strength</code>, <code>status</code>,
      <code>email_work</code> and <code>email_personal</code>. Download it, change the columns you want in Excel,
      upload it back. Matching on the id means nothing else in the file has to be right, and a three-column file of
      <code>id, stage, priority_tier</code> works just as well as the full export.</p>
  </section>

  <section>
    <h2>What this can and cannot change</h2>
    <ul class="meta" style="margin:0;padding-left:20px;line-height:1.7">
      <li><b>Writable:</b> ${FIELDS.map((f) => `<code>${f}</code>`).join(", ")} — the judgment fields (what you decide
        <i>about</i> a contact) plus the two email columns, matched safely here by <code>id</code> the same way
        every other field is.</li>
      <li><b>Not writable here:</b> names, employers, titles, phones, notes and every date. Those change one
        record at a time, on the record, so a spreadsheet autocorrect cannot reach them through a file.</li>
      <li><b>An email must look like one</b> — an <code>@</code> and no spaces — or the row is blocked rather than
        writing something wrong. Matching case is ignored, so re-typing the same address in a different case is not
        a change.</li>
      <li><b>A blank cell means leave it alone</b>, and so does leaving the column out. Clearing a field is not
        possible through this route — on a 4,000-row file that would be a mass deletion dressed as a no-op.</li>
      <li><b>Both spellings work.</b> <code>not_qualified</code> or <code>Not Qualified</code>, either column.</li>
      <li><b>Stage changes made here stay out of <a href="/pipeline">Pipeline</a> movement.</b> A bulk sweep is
        reclassification, not relationship movement — 400 arrivals into Retired in one second would bury every real
        signal on that page. The change is still recorded in the contact's history.</li>
    </ul>
  </section>
</main>`,
    })
  )
);

// ---------------------------------------------------------------- preview

app.post("/update/preview", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.redirect("/update");
  const text = await file.text();
  const grid = parseCsv(text);
  const bail = (msg: string) =>
    c.html(
      layout({
        title: "Update Contacts from a File",
        body: `<main><div class="flash warn">${esc(msg)}</div><p><a href="/update">Try another file</a></p></main>`,
      })
    );
  if (grid.length < 2) return bail("That file has no data rows.");

  const header = grid[0].map((h) => h.trim().toLowerCase());
  const present = new Set(header);
  if (!present.has("id"))
    return bail(
      "That file has no id column, so there is no way to tell which contact each row means. Start from /export/contacts.csv, which includes it."
    );
  const writable = FIELDS.filter((f) => present.has(f));
  if (!writable.length)
    return bail(
      `That file carries none of the columns this page can write: ${FIELDS.join(", ")}. Nothing would change.`
    );

  const staged = grid.slice(1).map((line, i) => {
    const rec: Record<string, string> = {};
    header.forEach((h, j) => (rec[h] = line[j] ?? ""));
    return stageUpdate(rec, i + 2, present);
  });

  const current = await loadCurrent(
    c.env.DB,
    staged.map((s) => s.id).filter((v): v is number => v !== null)
  );

  const rows: StagedUpdate[] = staged.map((s) => {
    const cur = s.id === null ? null : current.get(s.id) ?? null;
    const errors = [...s.errors];
    if (s.id !== null && !cur) errors.push(`no contact with id ${s.id} — it may have been deleted`);
    const changes: Change[] = [];
    if (cur)
      for (const f of FIELDS) {
        const want = s.wanted[f];
        if (want === undefined) continue;
        const from = currentValue(cur, f);
        if (from === want) continue;
        changes.push({ field: f, from, to: want });
      }
    return { row: s.row, id: s.id, raw: s.raw, current: cur, changes, errors };
  });

  const blocked = rows.filter((r) => r.errors.length);
  const changing = rows.filter((r) => !r.errors.length && r.changes.length);
  const unchanged = rows.filter((r) => !r.errors.length && !r.changes.length);

  const perField = new Map<Field, number>();
  for (const r of changing) for (const ch of r.changes) perField.set(ch.field, (perField.get(ch.field) ?? 0) + 1);

  const stageMoves = new Map<string, number>();
  for (const r of changing)
    for (const ch of r.changes)
      if (ch.field === "stage")
        stageMoves.set(
          `${stageLabel(ch.from)} → ${stageLabel(ch.to)}`,
          (stageMoves.get(`${stageLabel(ch.from)} → ${stageLabel(ch.to)}`) ?? 0) + 1
        );

  const rowHtml = rows
    .map((r) => {
      const bad = r.errors.length > 0;
      const noop = !bad && r.changes.length === 0;
      const tint = bad ? ' style="background:var(--warn-bg,#fff6f6)"' : noop ? ' class="muted"' : "";
      const who = r.current
        ? `${esc(r.current.full_name)}${r.current.organization ? ` <span class="meta">· ${esc(r.current.organization)}</span>` : ""}`
        : `<span class="meta">—</span>`;
      const detail = bad
        ? `<span class="pill red">blocked</span> <span class="meta">${esc(r.errors.join("; "))}</span>`
        : noop
          ? `<span class="meta">already matches the file</span>`
          : r.changes
              .map(
                (ch) =>
                  `<div><b>${LABELS[ch.field]}</b> <span class="meta">${esc(show(ch.field, ch.from))}</span> → <b>${esc(show(ch.field, ch.to))}</b></div>`
              )
              .join("");
      return `<tr${tint} data-row="${r.row}">
  <td>${
    bad || noop
      ? ""
      : `<label style="display:block;padding:14px"><input type="checkbox" name="take" value="${r.row}" checked></label>`
  }</td>
  <td class="meta">${r.row}</td>
  <td class="meta">${r.id ?? ""}</td>
  <td>${who}</td>
  <td>${detail}</td>
</tr>`;
    })
    .join("");

  // The applicable set is re-derived on commit from the file's own bytes, so the payload carries the
  // parsed rows rather than a list of ids — same shape as the importer, same reason: the commit must
  // validate against current state again, not trust what the preview computed.
  const payload = JSON.stringify(
    changing.map((r) => ({ row: r.row, id: r.id, changes: r.changes }))
  );

  return c.html(
    layout({
      title: "Update Contacts from a File",
      body: `<main>
  <h1>Review These Updates</h1>
  <p class="sub">${esc(file.name)} · ${rows.length} row${rows.length === 1 ? "" : "s"} ·
    columns this file can write: ${writable.map((f) => `<code>${f}</code>`).join(", ")}</p>

  <div class="card">
    <dl class="kv">
      <dt>Will change</dt><dd><b>${changing.length}</b> contact${changing.length === 1 ? "" : "s"}</dd>
      <dt>Already match</dt><dd>${unchanged.length}</dd>
      <dt>Blocked</dt><dd>${blocked.length}</dd>
    </dl>
    ${
      perField.size
        ? `<p class="meta" style="margin:10px 0 0">Fields touched: ${[...perField]
            .map(([f, n]) => `${LABELS[f]} ${n}`)
            .join(" · ")}</p>`
        : ""
    }
    ${
      stageMoves.size
        ? `<p class="meta" style="margin:6px 0 0">Stage moves: ${[...stageMoves]
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => `${esc(k)} ${n}`)
            .join(" · ")}</p>`
        : ""
    }
  </div>

  ${
    changing.some((r) => r.changes.some((ch) => ch.field === "stage"))
      ? `<div class="flash warn">These stage changes will <b>not</b> appear in <a href="/pipeline">Pipeline</a> movement.
         A bulk sweep is reclassification, not relationship movement, so counting it would bury the real signal on that
         page. Each change is still recorded in the contact's own history.</div>`
      : ""
  }

  <form method="post" action="/update/commit">
    <input type="hidden" name="payload" value="${esc(payload)}">
    <input type="hidden" name="filename" value="${esc(file.name)}">
    <div class="tablewrap">
      <table>
        <thead><tr><th></th><th>Row</th><th>id</th><th>Contact</th><th>Change</th></tr></thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>
    <div class="actions" style="margin-top:14px">
      <button type="submit"${changing.length ? "" : " disabled"}>Apply ${changing.length} Update${changing.length === 1 ? "" : "s"}</button>
      <a class="btn secondary" href="/update">Start Over</a>
    </div>
  </form>
</main>`,
    })
  );
});

// ---------------------------------------------------------------- commit

app.post("/update/commit", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const filename = typeof body.filename === "string" ? body.filename : "unknown.csv";
  const takeRaw = body.take;
  const take = new Set(
    (Array.isArray(takeRaw) ? takeRaw : takeRaw === undefined ? [] : [takeRaw]).map((v) => Number(v))
  );

  let submitted: { row: number; id: number; changes: Change[] }[] = [];
  try {
    submitted = JSON.parse(typeof body.payload === "string" ? body.payload : "[]");
  } catch {
    return c.redirect("/update");
  }
  const chosen = submitted.filter((s) => take.has(s.row) && s.id && s.changes.length);
  if (!chosen.length) return c.redirect("/update?flash=nothing");

  // Re-read current state. The preview may be minutes old and a record could have been edited on the
  // contact page since — in which case that field is no longer ours to overwrite from a stale file.
  const current = await loadCurrent(c.env.DB, chosen.map((s) => s.id));

  const applied: { id: number; name: string; changes: Change[] }[] = [];
  const stale: string[] = [];
  const statements: ReturnType<D1Db["prepare"]>[] = [];

  for (const s of chosen) {
    const cur = current.get(s.id);
    if (!cur) {
      stale.push(`id ${s.id} no longer exists`);
      continue;
    }
    /*
     * Only apply a change whose FROM still matches what is stored. A field edited on the record since
     * the preview was drawn belongs to that edit, not to this file — the same principle the contact
     * form uses for a follow-up date the operator typed. Reported, never silently dropped.
     */
    const live = s.changes.filter((ch) => {
      const from = currentValue(cur, ch.field);
      if (from === ch.to) return false;
      if (from !== ch.from) {
        stale.push(
          `${cur.full_name}: ${LABELS[ch.field]} is now ${show(ch.field, from)}, not ${show(ch.field, ch.from)} — left as it is`
        );
        return false;
      }
      return true;
    });
    if (!live.length) continue;

    const sets = live.map((ch) => `${ch.field}=?`).join(", ");
    statements.push(
      c.env.DB.prepare(`UPDATE contact SET ${sets}, updated_at=datetime('now') WHERE id=?`).bind(
        ...live.map((ch) => (ch.field === "priority_tier" ? Number(ch.to) : ch.to)),
        s.id
      )
    );
    applied.push({ id: s.id, name: cur.full_name, changes: live });
  }

  /*
   * Where the last stage-event id sits BEFORE the writes, so the trigger rows this batch produces can
   * be re-marked afterwards. The trigger cannot know why the stage moved — it has no actor and no
   * context — so the origin is corrected here instead. Safe in a single-operator app; if this ever
   * becomes multi-user, the honest fix is passing context into the write rather than inferring it from
   * an id watermark, and this comment is the flag for that day.
   */
  const before = await c.env.DB.prepare("SELECT COALESCE(MAX(id),0) AS m FROM contact_stage_event").first<{
    m: number;
  }>();
  const watermark = before?.m ?? 0;

  // Batched: one subrequest per BATCH_SIZE statements, and each batch is a transaction that rolls back
  // whole. The 2026-08-20 import died doing this one statement at a time.
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    await c.env.DB.batch(statements.slice(i, i + BATCH_SIZE));
  }

  const stageChanged = applied.filter((a) => a.changes.some((ch) => ch.field === "stage")).length;
  if (stageChanged) {
    await c.env.DB.prepare("UPDATE contact_stage_event SET origin=? WHERE id > ? AND origin='trigger'")
      .bind(BULK_ORIGIN, watermark)
      .run();
  }

  /*
   * Per-contact audit rows, BATCHED. Writing these one at a time is the mistake that killed the
   * 2026-08-20 import: a 400-row sweep would be 400 sequential round trips on top of the updates
   * themselves, and the audit trail is exactly the thing you cannot afford to lose half of.
   */
  const correlation = `bulk-update-${watermark}`;
  const auditStmt = c.env.DB.prepare(
    `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
     VALUES (?,?,?,'update',?,?,'bulk-update',?)`
  );
  const auditRows = applied.map((a) =>
    auditStmt.bind(
      ACTOR,
      "contact",
      String(a.id),
      a.name,
      a.changes.map((ch) => `${ch.field} ${show(ch.field, ch.from)} → ${show(ch.field, ch.to)}`).join("; ") +
        ` (bulk update from ${filename})`,
      correlation
    )
  );
  for (let i = 0; i < auditRows.length; i += BATCH_SIZE) {
    await c.env.DB.batch(auditRows.slice(i, i + BATCH_SIZE));
  }

  await c.env.DB.prepare(
    `INSERT INTO audit_event (actor, entity, entity_id, action, before_summary, after_summary, source, correlation_id)
     VALUES (?,?,?,?,?,?,?,?)`
  )
    .bind(
      ACTOR,
      "contact",
      "batch",
      "bulk-update",
      `${submitted.length} changed row${submitted.length === 1 ? "" : "s"} offered from ${filename}; ${chosen.length} selected`,
      `${applied.length} contact${applied.length === 1 ? "" : "s"} updated${
        stageChanged ? `, ${stageChanged} of them a stage change recorded as ${BULK_ORIGIN}` : ""
      }${stale.length ? `; ${stale.length} field${stale.length === 1 ? "" : "s"} skipped as changed since the preview` : ""}`,
      "bulk-update",
      correlation
    )
    .run();

  return c.html(
    layout({
      title: "Updates Applied",
      body: `<main>
  <h1>Updates Applied</h1>
  <p class="sub">${esc(filename)}</p>
  <div class="card">
    <dl class="kv">
      <dt>Contacts updated</dt><dd><b>${applied.length}</b></dd>
      <dt>Stage changes</dt><dd>${stageChanged}${stageChanged ? ` <span class="meta">· recorded in history, excluded from Pipeline movement</span>` : ""}</dd>
      <dt>Skipped</dt><dd>${stale.length}</dd>
    </dl>
  </div>
  ${
    stale.length
      ? `<div class="flash warn"><b>${stale.length} field${stale.length === 1 ? "" : "s"} left alone</b> because
         ${stale.length === 1 ? "it had" : "they had"} changed since the preview was drawn — an edit made on the record
         wins over a stale file.<ul style="margin:8px 0 0;padding-left:20px">${stale
           .slice(0, 25)
           .map((s) => `<li>${esc(s)}</li>`)
           .join("")}</ul>${stale.length > 25 ? `<p class="meta" style="margin:6px 0 0">…and ${stale.length - 25} more, all in the audit trail.</p>` : ""}</div>`
      : ""
  }
  <div class="actions"><a class="btn" href="/contacts">Back to Contacts</a>
    <a class="btn secondary" href="/update">Another File</a></div>
</main>`,
    })
  );
});

export default app;
