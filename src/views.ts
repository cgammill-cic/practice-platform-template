import { TERMINAL_STAGES } from "./types";
// HTML rendering helpers. Server-rendered, no client framework — fast and simple for a single user.

export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  :root { --ink:#1a2332; --accent:#2563eb; --line:#e2e8f0; --muted:#64748b; --bg:#f8fafc; }
  * { box-sizing:border-box; }
  body { font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); margin:0; background:var(--bg); }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  header { background:#fff; border-bottom:1px solid var(--line); padding:12px 24px; display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; }
  header nav { display:flex; gap:16px; font-size:14px; align-items:center; flex-wrap:wrap; }
  main { max-width:900px; margin:24px auto 60px; padding:0 20px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0 0 8px; color:var(--accent); }
  .sub { color:var(--muted); font-size:14px; margin:0 0 20px; }
  section, .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; background:#fff; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); font-size:14px; vertical-align:top; }
  th { background:#f1f5f9; font-weight:600; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  tr:last-child td { border-bottom:0; }
  .pill { display:inline-block; padding:2px 8px; border-radius:99px; font-size:12px; background:#eff6ff; color:#1e40af; white-space:nowrap; }
  .pill.grey { background:#f1f5f9; color:var(--muted); }
  .pill.red { background:#fef2f2; color:#b91c1c; }
  .pill.amber { background:#fffbeb; color:#92400e; }
  .pill.green { background:#f0fdf4; color:#166534; }
  label { display:block; font-size:13px; font-weight:600; margin:12px 0 4px; color:var(--ink); }
  label .hint { font-weight:400; color:var(--muted); }
  input[type=text], input[type=email], input[type=date], input[type=password], input[type=url], input[type=number], input[type=file], select, textarea {
    width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:15px; font-family:inherit; background:#fff; }
  textarea { min-height:80px; resize:vertical; }
  button, .btn { display:inline-block; padding:9px 16px; background:var(--accent); color:#fff; border:0; border-radius:8px; font-size:15px; cursor:pointer; text-decoration:none; }
  button.secondary, .btn.secondary { background:#fff; color:var(--ink); border:1px solid var(--line); }
  button.danger { background:#b91c1c; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .row > * { flex:1 1 220px; }
  .actions { margin-top:20px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .actions form { margin:0; }
  .banner { padding:10px 24px; font-size:14px; }
  .banner.warn { background:#fef2f2; color:#b91c1c; border-bottom:1px solid #fecaca; }
  .banner.info { background:#eff6ff; color:#1e40af; border-bottom:1px solid #bfdbfe; }
  .empty { color:var(--muted); font-size:14px; padding:18px; text-align:center; }
  .searchbar { display:flex; gap:8px; margin-bottom:16px; }
  .searchbar input { flex:1; }
  .meta { color:var(--muted); font-size:13px; }
  .flash { padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:14px; }
  .flash.ok { background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; }
  .flash.warn { background:#fffbeb; color:#92400e; border:1px solid #fde68a; }
  .grid2 { display:grid; grid-template-columns:150px 1fr; gap:6px 14px; font-size:14px; }
  .grid2 dt { color:var(--muted); }
  /* A long work email in a narrow value column is the one string here with no break opportunity in it,
     and it pushed the page 28px wider than a 390px phone until this was added (caught by measuring
     scrollWidth against innerWidth, not by eye). Set on both axes of the grid, since a grid item will
     otherwise refuse to shrink below its longest word. */
  .grid2 dd { margin:0; min-width:0; overflow-wrap:anywhere; }
  /* The phone treatment of .grid2 lives in the media query further down with the rest of UX-001 (#56).
     It used to stack into one column here; that rule was replaced rather than overridden, so there is
     one statement of what a phone does to this block instead of two that disagree. */

  /* Inline checkbox with its label on one line, normal weight. */
  label.check { display:flex; gap:8px; align-items:center; font-weight:400; margin-top:14px; }
  label.check input { width:auto; }

  /* Quick-set buttons — each is its own tiny POST form, so no JavaScript is needed. */
  .quickset { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); }
  .quickset form { margin:0; }
  .quickset button { padding:6px 12px; font-size:14px; }

  /* Collapsible dashboard sections (#70). Same ▸/▾ vocabulary as the interaction history below, so
     the two expandable things in the app look like the same control. The <details> sits INSIDE the
     <section> rather than replacing it, which keeps the card border, padding and spacing from the
     "section, .card" rule above — collapsing changes what is inside the card, not the card itself. */
  .dash > summary { cursor:pointer; list-style:none; display:flex; align-items:center; gap:8px; }
  .dash > summary::-webkit-details-marker { display:none; }
  .dash > summary:before { content:"▸"; color:var(--muted); font-size:11px; width:10px; flex:none; }
  .dash[open] > summary:before { content:"▾"; }
  .dash > summary h2 { margin:0; }
  .dash > summary:hover h2 { text-decoration:underline; }
  .dash[open] > summary { margin-bottom:10px; }

  /* A small control that still has to be hittable with a thumb (UX-001). Was inline styles on the
     action-item Done buttons; a class instead, so the phone rules below can override the size. An
     inline style cannot be beaten by a media query without !important, which is a fight worth not
     having. */
  button.tiny { padding:5px 10px; font-size:13px; }

  /* ------------------------------------------------------------------ phone (UX-001, #56)
     "I want to ensure that at some point, I can use this app on my iPhone." (2026-07-31)
     It already worked — server-rendered HTML with a viewport tag — so this is about it being
     pleasant. Optimised for the three things that actually happen on a phone: glance at today's
     meetings on the way to one, tick an action item done, and log a note in the car afterwards.

     TABLES BECOME CARDS. Seven columns cannot survive a 390px screen; they either overflow or
     squeeze every cell to two words. Each row becomes a bordered card and each cell a labelled
     line, which is the same information in the shape a phone can show.

     The label comes from a data-label attribute on the cell, so a table opts in by carrying them.
     (No backticks in this comment on purpose — the whole stylesheet is a template literal.) Tables that
     do not — audit, templates, import preview — still stack rather than overflow: they lose the
     column headings on a phone but stay readable, and those are desk work anyway. Adding a label is
     one attribute when any of them earns it.

     TAP TARGETS. Apple's guidance is ~44pt; the Done buttons were 12px text with 4px padding, which
     is roughly half. Everything clickable gets a 44px minimum here rather than only the buttons that
     were obviously too small, because the next small control added should inherit the rule. */
  /* Shown only on a phone. Used for the jump-to-the-form link on a contact record, and for the note
     that import is desk work. Display is set in the media query below, so it is invisible by default —
     a rule that fails closed, rather than one that leaks phone furniture onto the desktop. */
  .phone-only { display:none; }

  @media (max-width:640px) {
    .phone-only { display:block; margin:0 0 12px; }
    /* The relationship block keeps its label/value columns rather than stacking into two lines per
       field. A contact record carries seventeen fields and most are usually empty, so stacked they
       cost thirty-four lines of scrolling to say almost nothing. Narrower label column, same shape. */
    .grid2 { grid-template-columns:104px 1fr; gap:6px 10px; font-size:13px; }
    .grid2 dt { margin-top:0; }
    main { margin:14px auto 48px; padding:0 12px; }
    header { padding:10px 14px; }
    header nav { gap:10px 14px; font-size:15px; }
    header nav a { padding:7px 0; }
    h1 { font-size:20px; }
    section, .card { padding:14px; }

    table { border:0; background:transparent; border-radius:0; overflow:visible; }
    thead { display:none; }
    table, tbody, tr, td { display:block; width:100%; }
    tbody tr { background:#fff; border:1px solid var(--line); border-radius:10px; padding:6px 0; margin-bottom:10px; }
    tbody tr:last-child { margin-bottom:0; }
    /* text-align is overridden because several cells carry an inline right-align that only makes
       sense in a column. In a stacked card everything reads from the left edge. */
    td { border-bottom:0; padding:5px 12px; text-align:left !important; }
    td:empty { display:none; }
    td[data-label]:before {
      content:attr(data-label); display:block; font-size:11px; text-transform:uppercase;
      letter-spacing:.03em; color:var(--muted); margin-bottom:1px; }

    button, .btn, button.tiny { min-height:44px; padding:11px 16px; font-size:15px; }
    /* Text inputs and selects were missed when UX-001 set the 44px floor — it covered buttons and the
       row action links, and every form field stayed at roughly 38px. Caught by measuring the time entry
       form (TIME-001), which is mostly fields and is meant to be usable one-handed after a meeting. The
       rule above already said the intent was that the next small control should inherit it, so this is
       that rule finally applying to the controls it always described. */
    input[type=text], input[type=email], input[type=date], input[type=password], input[type=url],
    input[type=number], select { min-height:44px; }
    /* The row's edit / delete / LinkedIn links are controls, not prose, so they get the same treatment
       as the buttons. Scoped to the cell that holds them — the same rule on every link in a table would
       stretch the "from the 30 July Intro call" provenance line into a row of 44px slabs. */
    td.rowacts { padding-top:8px; }
    td.rowacts a { display:inline-flex; align-items:center; min-height:44px; padding:0 10px 0 0; }
    .quickset button { min-height:44px; }
    /* A pill used as a link is a control on the meeting rows — Held, Cancelled, No-Show. */
    a.pill { min-height:44px; display:inline-flex; align-items:center; padding:6px 12px; margin:3px 4px 3px 0; }
    .actions { gap:8px; }
    .actions form, .actions button, .actions .btn { flex:1 1 auto; }
  }

  /* Proportional bar for the weekly hours report (TIME-001).
     One colour, the existing --accent, rather than a palette: every bar on that page measures the same
     quantity in the same unit, so colouring them differently would encode nothing and imply a category
     that does not exist. Width is set inline as a percentage of the largest row in its own group.
     min-width so a 0.25h row is still a visible mark rather than nothing at all. */
  .barwrap { background:#eef2f7; border-radius:3px; overflow:hidden; margin-top:5px; height:6px; }
  .bar { height:6px; background:var(--accent); border-radius:3px; min-width:2px; }
  /* Numbers that get compared down a column must not wander. */
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }

  /* Interaction history: one line per touch, expandable */
  .hist { border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .hist-row { border-bottom:1px solid var(--line); font-size:14px; }
  .hist-row:last-child { border-bottom:0; }
  .hist-row > summary, .hist-flat { padding:9px 12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; cursor:pointer; list-style:none; }
  .hist-flat { cursor:default; }
  .hist-row > summary::-webkit-details-marker { display:none; }
  .hist-row > summary:before { content:"▸"; color:var(--muted); font-size:11px; width:10px; flex:none; }
  .hist-row[open] > summary:before { content:"▾"; }
  .hist-flat:before { content:""; width:10px; flex:none; }
  .hist-row > summary:hover { background:#f8fafc; }
  .hist-date { font-variant-numeric:tabular-nums; color:var(--muted); flex:none; }
  .hist-subject { flex:1 1 200px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hist-detail { padding:2px 12px 14px 34px; border-top:1px dashed var(--line); background:#fcfdfe; }
  .hist-detail > div { margin:6px 0; }
  .hist-more { margin-top:8px; }
  .hist-more > summary { font-size:13px; color:var(--accent); cursor:pointer; padding:6px 0; }
`;

export function layout(opts: { title: string; body: string; banner?: string; nav?: boolean }): string {
  const nav =
    opts.nav === false
      ? ""
      : `<header>
  <!--
    A small mark beside the name. 22px tall, which is the cap height of the text next to it — the header
    is on every page and every pixel of it is scroll a phone pays for, so the mark sits inside the line
    that already existed rather than adding a band above it. The header grew by nothing.

    The image is the mark only — see src/icons.ts to replace it with your own.

    Fixed width and height attributes so the line does not reflow while the image loads, and empty alt
    text because the words next to it already say what it is; a screen reader announcing "logo, Practice
    Platform" is noise.
  -->
  <b><a href="/" style="color:inherit;white-space:nowrap"><img src="/logo.png" alt="" width="44" height="20" style="vertical-align:-4px;margin-right:9px">Practice Platform</a></b>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/contacts">Contacts</a>
    <a href="/actions">Action Items</a>
    <a href="/pipeline">Pipeline</a>
    <!--
      TWO THINGS COULD HAVE BEEN CALLED "PIPELINE" AND ONLY ONE IS. /pipeline is the relationship
      pipeline — contacts by stage, which is what this app was first for. /pursuits is the sales pipeline
      — work being chased, by lifecycle stage (PURS-001). Naming both "Pipeline" would have been accurate
      and useless, so the newer one is "Pursuits", which is also the word used for it when it was requested.
    -->
    <a href="/pursuits">Pursuits</a>
    <a href="/engagements">Customers</a>
    <a href="/organizations">Companies</a>
    <a href="/templates">Templates</a>
    <a href="/contacts/new">Add Contact</a>
    <a href="/import">Import</a>
    <a href="/email/import">Email</a>
    <a href="/update">Update</a>
    <a href="/export">Export</a>
    <a href="/audit">Audit</a>
    <a href="/health">Health</a>
    <a href="/activities">Activities</a>
    <a href="/feedback">Feedback</a>
    <a href="/logout">Sign Out</a>
  </nav>
</header>${opts.banner ?? ""}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<!--
  Home Screen support (UX-001, #56). "Add to Home Screen" on an iPhone produces a real icon and opens
  without Safari chrome once these exist; before them it was a screenshot thumbnail in a browser tab.
  apple-mobile-web-app-capable is the deprecated spelling that iOS still honours, and mobile-web-app-capable
  is the standard one — both are here because Safari reads the first and everything else reads the second.
  viewport-fit=cover is deliberately NOT set: it would push content under the notch and the home bar.
-->
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/png" href="/icon.png">
<meta name="theme-color" content="#1a2332">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Practice">
<!-- "black", not "black-translucent": translucent draws the page UNDER the status bar, which would put
     the clock on top of the header. Opaque keeps the layout honest. -->
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<title>${esc(opts.title)} · Practice Platform</title>
<style>${STYLE}</style>
</head>
<body>${nav}${opts.body}</body>
</html>`;
}

/** Renders a <select>. options = [value, label, hint?][] */
export function select(
  name: string,
  options: readonly (readonly [string, string, string?])[],
  current: string | null,
  opts: { blank?: string } = {}
): string {
  const blank = opts.blank ? `<option value="">${esc(opts.blank)}</option>` : "";
  const items = options
    .map(
      ([v, label, hint]) =>
        `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(label)}${hint ? ` — ${esc(hint)}` : ""}</option>`
    )
    .join("");
  return `<select name="${esc(name)}">${blank}${items}</select>`;
}

/**
 * Meeting times are stored as free text, so they arrive in whatever shape they were written —
 * "10 am", "10:30am", "2 PM". On the hour they read as a bare hour, which sits oddly beside the times
 * that do carry minutes (raised 2026-07-30). This normalizes the display only: minutes are always
 * shown, and am/pm is lower-cased and spaced. Anything that is not recognizably a clock time is
 * returned untouched, so a note like "after standup" still displays as written.
 */
export function formatTime(raw: string | null): string {
  if (!raw) return "";
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*$/i.exec(raw);
  if (!m) return raw.trim();
  return `${Number(m[1])}:${m[2] ?? "00"} ${m[3].toLowerCase()}m`;
}

/** Whole days from today to an ISO date. Negative means the date has passed. */
export function dayDelta(date: string, from: string = new Date().toISOString().slice(0, 10)): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * A follow-up date with its distance from today, so a list is scannable without doing date arithmetic
 * in your head. "Reach Out Later · in 28d" carries the same information as a stage named "reach out in
 * 4 weeks" — but the date is a fact on the record rather than an offset to be recomputed later
 * (raised 2026-07-30).
 */
export function followUpPill(date: string | null, stage?: string | null): string {
  if (!date) return '<span class="pill grey">none set</span>';
  const today = new Date().toISOString().slice(0, 10);
  /*
   * A TERMINAL CONTACT IS NEVER OVERDUE, and this pill used to say otherwise.
   *
   * The dashboard's Overdue section has always excluded terminal stages — a contact you are finished with
   * is not late. This pill did not know the stage, so on the contacts list ten `complete` contacts carrying
   * a leftover date were painted red "overdue 48d" while the dashboard correctly said nothing was wrong.
   * Two screens disagreeing about the same fact is worse than either answer alone: it teaches you to
   * distrust both. Found 2026-08-18 while investigating the Stay Connected report.
   *
   * The date is still shown rather than hidden — it is real, it is just no longer a deadline.
   */
  if (stage && TERMINAL_STAGES.some((v) => v === stage))
    return `<span class="pill grey">${esc(date)} · no longer due</span>`;
  if (date === today) return '<span class="pill amber">today</span>';
  const days = dayDelta(date, today);
  if (days < 0) return `<span class="pill red">overdue ${Math.abs(days)}d · ${esc(date)}</span>`;
  return `<span class="pill green">${esc(date)} · in ${days}d</span>`;
}
