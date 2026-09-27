import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { TERMINAL_STAGES, type Bindings } from "./types";
import { adminOnlyPath, isAdmin, whoami } from "./auth";
import { appSettings } from "./settings";
import { pendingCountCached } from "./migrate";

/** Cache-busting suffixes for the brand images: change when a new one is uploaded on Settings. */
export const logoV = () => (appSettings().logo ? `?v=${encodeURIComponent(appSettings().logo!)}` : "");
export const iconV = () => {
  const v = appSettings().icon ?? appSettings().logo;
  return v ? `?v=${encodeURIComponent(v)}` : "";
};
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

/*
 * Theme tokens ("Command Console", 2026-09-14). Two full palettes rather than one — dark is the
 * default for every first visit, light is one click away, and neither is derived from the other by
 * filters or opacity tricks. Every color a component needs has a name here; a component should never
 * reach for a literal hex value, because that is exactly the thing that would silently ignore a theme
 * switch.
 *
 * `prefers-color-scheme` is deliberately NOT consulted. This is a choice, not an oversight: once the
 * cookie exists it is the only source of truth, and a media query fighting an explicit click is a real
 * bug class (flash-of-wrong-theme on a browser whose OS setting disagrees with what was chosen last
 * time). Dark renders on a first visit regardless of OS setting.
 */
const STYLE = `
  :root {
    --bg:#0e1116; --surface:#161a21; --surface-2:#1c212a; --ink:#e7e9ee; --muted:#8890a0; --faint:#838ba0;
    --line:#262b35; --accent:#7c6fe8; --accent-tint:#221f3a; --amber:#e0a94a; --amber-tint:#332b19;
    --red:#e2685f; --red-tint:#331d1c; --green:#5fbf8f; --green-tint:#122a20;
  }
  /* Same specificity as :root (both target <html>), so source order decides — this block must stay
     second, and nothing later should add a third override that could silently win by accident. */
  html[data-theme="light"] {
    --bg:#f4f5f8; --surface:#ffffff; --surface-2:#eceef2; --ink:#14171d; --muted:#5b6272; --faint:#666d7d;
    --line:#dde1e8; --accent:#6a5cd6; --accent-tint:#efedfd; --amber:#a8720d; --amber-tint:#fbf0da;
    --red:#b23b34; --red-tint:#fbeae8; --green:#2f7d5e; --green-tint:#e8f5ee;
  }
  * { box-sizing:border-box; }
  body { font:16px/1.5 "Sora",system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--ink); margin:0; background:var(--bg); }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  /* Seeded now for later phases to apply to specific date/number spans in prose or pills. Scope in
     this pass stays narrow — see .num and .hist-date below — rather than monospacing every td. */
  .mono { font-family:"JetBrains Mono",ui-monospace,"SFMono-Regular","Courier New",monospace; }

  /* ------------------------------------------------------------------ shell: rail + content
     Replaces the flat 18-link <header nav> (2026-09-14). That list had grown one link at a time since
     #56 and had no grouping, no icons, and no sense of where you were — a genuinely different problem
     from "not enough color". Grouped by the actual shape of the work (Relationships, Pursuits, Time,
     Data) rather than by when a link was added. */
  .shell { display:flex; min-height:100vh; align-items:flex-start; }
  /* Sticky, not just flex-stretched: a dashboard taller than one screen used to stretch the rail's own
     box to match it, leaving blank space below the (much shorter) nav once you scrolled past it. Pinned
     to the viewport instead, so the rail is where you left it regardless of how far main-area scrolls. */
  .rail { width:228px; flex:none; position:sticky; top:0; height:100vh; background:var(--surface);
    border-right:1px solid var(--line); display:flex; flex-direction:column; padding:16px 12px; }
  .rail-brand { padding:4px 8px 18px; }
  .rail-brand a { display:flex; align-items:center; gap:9px; color:inherit; }
  .rail-brand a:hover { text-decoration:none; }
  .rail-brand b { font-size:14px; line-height:1.25; }
  .rail-nav { flex:1; overflow-y:auto; }
  .rail-group { margin-bottom:14px; }
  .rail-group-label { font-size:10.5px; font-weight:600; letter-spacing:.07em; text-transform:uppercase;
    color:var(--faint); padding:0 10px 5px; }
  .rail-link { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px;
    font-size:13.5px; font-weight:500; color:var(--muted); }
  .rail-link svg { flex:none; opacity:.8; }
  .rail-link:hover { background:var(--surface-2); color:var(--ink); text-decoration:none; }
  .rail-link.active { background:var(--accent-tint); color:var(--accent); }
  .rail-link.active svg { opacity:1; }
  .rail-foot { border-top:1px solid var(--line); padding-top:10px; margin-top:6px; }
  .rail-foot .rail-link { font-size:13px; }
  /* Two links, not a JS toggle — clicking either is already a navigation (a full re-render is what a
     theme switch needs anyway, and this way it needs zero client JS in an app that has almost none). */
  .theme-toggle { display:flex; gap:4px; padding:2px; background:var(--surface-2); border:1px solid var(--line);
    border-radius:8px; margin:4px 4px 10px; }
  .theme-toggle a { flex:1; text-align:center; padding:6px 0; border-radius:6px; color:var(--faint);
    font-size:12px; font-weight:600; }
  .theme-toggle a:hover { text-decoration:none; }
  .theme-toggle a.active { background:var(--surface); color:var(--ink); }

  .main-area { flex:1; min-width:0; }
  main { max-width:900px; margin:24px auto 60px; padding:0 20px; }
  h1 { font-size:22px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0 0 8px; color:var(--accent); }
  .sub { color:var(--muted); font-size:14px; margin:0 0 20px; }
  /* Chip-style link row (2026-09-14) — a page's utility links (browse all, export, clear filters...)
     as small pill buttons instead of plain text separated by "·", matching the pill/dot vocabulary the
     rest of the app already uses. .count is for a link carrying a number worth calling out (e.g. "8
     missing LinkedIn") — same accent tint as an active nav item, so it reads as worth a look. */
  .linkbar { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 20px; }
  .linkchip { display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:99px;
    background:var(--surface-2); border:1px solid var(--line); color:var(--muted); font-size:13px; }
  .linkchip:hover { background:var(--accent-tint); color:var(--accent); border-color:var(--accent); text-decoration:none; }
  .linkchip.count { background:var(--accent-tint); color:var(--accent); border-color:transparent; font-weight:600; }
  section, .card { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); font-size:14px; vertical-align:top; }
  th { background:var(--surface-2); font-weight:600; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  tr:last-child td { border-bottom:0; }
  /* The colored dot is pure CSS on the existing .pill — every pill everywhere in the app picks this up
     with no markup change, since followUpPill() and every call site keep emitting the exact same
     classes and text they always did. Restyling here, not there, is the whole point of centralizing it. */
  .pill { display:inline-flex; align-items:center; gap:5px; padding:2px 9px 2px 7px; border-radius:99px; font-size:12px; background:var(--surface-2); color:var(--muted); white-space:nowrap; }
  .pill:before { content:"●"; font-size:8px; }
  .pill.grey { background:var(--surface-2); color:var(--muted); }
  .pill.red { background:var(--red-tint); color:var(--red); }
  .pill.amber { background:var(--amber-tint); color:var(--amber); }
  .pill.green { background:var(--green-tint); color:var(--green); }
  /* Priority contact (migration 0029). The star replaces the status dot, because this pill is an
     identity marker, not a status — a dot would read as one more follow-up signal. */
  .pill.prio { background:var(--accent-tint); color:var(--accent); font-weight:600; }
  .pill.prio:before { content:"★"; font-size:10px; }
  /* ------------------------------------------------------------------ dashboard card-grid (Phase 2, 2026-09-14)
     Replaces the eight dashboard sections' <table><tr><td> rows with one shared shape: a status dot, an
     avatar-initials circle, a name/subtitle stack, and right-aligned metadata. The <details>/<summary>
     collapse mechanism above (".dash") is untouched — only what renders inside each section changes. */
  .stat-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin:18px 0 22px; }
  .stat { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:13px 15px; }
  .stat-num { font-size:24px; font-weight:700; line-height:1.15; font-family:"JetBrains Mono",ui-monospace,monospace; }
  .stat-label { color:var(--muted); font-size:12px; margin-top:3px; }

  /* Section header: icon + title on the left (the title stays an <h2>, so it keeps the font-size/color/
     margin already set on ".dash > summary h2" below), count badge pushed to the right. */
  .card-h { display:flex; align-items:center; gap:8px; }
  .card-h svg { flex:none; opacity:.85; }
  .card-h .count { margin-left:auto; background:var(--accent-tint); color:var(--accent); font-size:11.5px;
    font-weight:600; padding:2px 9px; border-radius:99px; font-family:"JetBrains Mono",ui-monospace,monospace; }

  /* ".listrow", not ".row" above — that is an existing form-layout flex utility used across the contact,
     engagement and organization forms, and reusing the name would collide with it. */
  .list { border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--surface); }
  .listrow { display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:1px solid var(--line);
    flex-wrap:wrap; }
  .listrow:last-child { border-bottom:0; }
  .dot { width:8px; height:8px; border-radius:50%; flex:none; background:var(--muted); }
  .dot.red { background:var(--red); }
  .dot.amber { background:var(--amber); }
  .dot.green { background:var(--green); }
  .dot.accent { background:var(--accent); }
  /* Stage column (Phase 3, 2026-09-14) — dot + plain text rather than a filled .pill, matching the
     approved contacts-list mockup: a denser, lighter-weight treatment for a page that is a working
     list of up to 300 rows rather than the dashboard's curated card-grid. */
  .stagewrap { display:flex; align-items:center; gap:6px; }
  .avatar { width:30px; height:30px; border-radius:50%; background:var(--surface-2); color:var(--muted);
    display:flex; align-items:center; justify-content:center; font-size:11.5px; font-weight:700; flex:none;
    font-family:"JetBrains Mono",ui-monospace,monospace; }
  .listrow-main { flex:1 1 auto; min-width:0; }
  .listrow-name { font-weight:600; }
  .listrow-meta { flex:none; text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:4px; }

  /* Contact record identity header (Phase 4, 2026-09-14) — a bordered bar in place of the bare <h1>,
     matching the approved ContactRecord mockup. Reuses .avatar (sized up) and .stagewrap rather than
     inventing a separate avatar shape or badge component. */
  .avatar.lg { width:42px; height:42px; font-size:15px; }
  .chead { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap;
    background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 18px; margin-bottom:14px; }
  .chead-id { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .chead-name { font-size:17px; font-weight:700; }
  .chead-sub { color:var(--muted); font-size:13px; }
  .chead-acts { display:flex; gap:8px; flex:none; }

  label { display:block; font-size:13px; font-weight:600; margin:12px 0 4px; color:var(--ink); }
  label .hint { font-weight:400; color:var(--muted); }
  input[type=text], input[type=email], input[type=date], input[type=password], input[type=url], input[type=number], input[type=file], select, textarea {
    width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:15px; font-family:inherit; background:var(--surface); color:var(--ink); }
  /* The two field types that are always numeric/date content, never prose — narrow on purpose. */
  input[type=date], input[type=number] { font-family:"JetBrains Mono",ui-monospace,monospace; }
  textarea { min-height:80px; resize:vertical; }
  /* Show/Hide on every password field (2026-09-25, the owner's request). Added by the small script at the
     end of layout(), so a new password field anywhere gets it without remembering to. */
  .pw-wrap { position:relative; }
  .pw-wrap input { padding-right:64px; }
  .pw-wrap .pw-toggle { position:absolute; right:4px; top:50%; transform:translateY(-50%); min-height:0;
    padding:5px 10px; font-size:13px; background:transparent; color:var(--muted); border:0; border-radius:6px; }
  .pw-wrap .pw-toggle:hover, .pw-wrap .pw-toggle:focus-visible { color:var(--ink); background:var(--surface-2); }
  button, .btn { display:inline-block; padding:9px 16px; background:var(--accent); color:#fff; border:0; border-radius:8px; font-size:15px; cursor:pointer; text-decoration:none; font-family:inherit; }
  button.secondary, .btn.secondary { background:var(--surface); color:var(--ink); border:1px solid var(--line); }
  button.danger { background:var(--red); }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .row > * { flex:1 1 220px; }
  .actions { margin-top:20px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .actions form { margin:0; }
  .banner { padding:10px 24px; font-size:14px; }
  .banner.warn { background:var(--red-tint); color:var(--red); border-bottom:1px solid var(--line); }
  .banner.info { background:var(--accent-tint); color:var(--accent); border-bottom:1px solid var(--line); }
  .empty { color:var(--muted); font-size:14px; padding:18px; text-align:center; }
  .searchbar { display:flex; gap:8px; margin-bottom:16px; }
  .searchbar input { flex:1; }
  .meta { color:var(--muted); font-size:13px; }
  .flash { padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:14px; }
  .flash.ok { background:var(--green-tint); color:var(--green); border:1px solid var(--line); }
  .flash.warn { background:var(--amber-tint); color:var(--amber); border:1px solid var(--line); }
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

  /* Shown only on a phone. Used for the jump-to-the-form link on a contact record, and for the note
     that import is desk work. Display is set in the media query below, so it is invisible by default —
     a rule that fails closed, rather than one that leaks phone furniture onto the desktop. */
  .phone-only { display:none; }

  @media (max-width:640px) {
    /* The rail collapses to a horizontal wrapping bar rather than staying a fixed vertical column —
       the same shape the old flat header nav already used on a phone, just carrying icon+label items
       and grouping labels hidden (they read as one flat wrapping list either way at this width). No new
       client JS: no drawer, no hamburger, nothing to wire up. */
    .shell { flex-direction:column; min-height:0; }
    .rail { width:auto; height:auto; position:static; flex-direction:row; flex-wrap:wrap; align-items:center;
      padding:8px 10px; gap:2px; border-right:0; border-bottom:1px solid var(--line); }
    .rail-brand { padding:2px 8px; margin-right:auto; }
    .rail-nav { flex:none; width:100%; order:3; overflow:visible; display:flex; flex-wrap:wrap; gap:2px; }
    .rail-group { display:contents; }
    .rail-group-label { display:none; }
    .rail-link { padding:7px 9px; }
    .rail-foot { border-top:0; margin:0; padding:0; order:2; margin-left:auto; display:flex; flex-wrap:wrap; align-items:center; gap:4px; max-width:100%; }
    /* The signed-in name (AUTH-001) is the lock icon alone here; the name is in its title and on /account. */
    .rail-me { display:none; }
    .theme-toggle { margin:0; }

    .phone-only { display:block; margin:0 0 12px; }
    /* The contact-record header bar (Phase 4) stacks rather than trying to keep the avatar/name/stage
       row and the action buttons on one line at this width. */
    .chead { flex-direction:column; align-items:stretch; }
    .chead-acts { width:100%; }
    .chead-acts .btn { flex:1 1 auto; }
    /* The relationship block keeps its label/value columns rather than stacking into two lines per
       field. A contact record carries seventeen fields and most are usually empty, so stacked they
       cost thirty-four lines of scrolling to say almost nothing. Narrower label column, same shape. */
    .grid2 { grid-template-columns:104px 1fr; gap:6px 10px; font-size:13px; }
    .grid2 dt { margin-top:0; }
    main { margin:14px auto 48px; padding:0 12px; }
    h1 { font-size:20px; }
    section, .card { padding:14px; }

    table { border:0; background:transparent; border-radius:0; overflow:visible; }
    thead { display:none; }
    table, tbody, tr, td { display:block; width:100%; }
    tbody tr { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:6px 0; margin-bottom:10px; }
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

    /* The listrow shape (Phase 2) isn't a table, so the table→card transform above doesn't touch it —
       it needs its own phone rule. The meta column drops below the name/subtitle and reads from the left
       edge, same convention as .grid2 above, rather than staying right-aligned in a narrowed column. */
    .stat-row { grid-template-columns:repeat(2,1fr); gap:8px; }
    .listrow-meta { flex:1 1 100%; align-items:flex-start; text-align:left; padding-left:40px; margin-top:2px; }
  }

  /* Proportional bar for the weekly hours report (TIME-001).
     One colour, the existing --accent, rather than a palette: every bar on that page measures the same
     quantity in the same unit, so colouring them differently would encode nothing and imply a category
     that does not exist. Width is set inline as a percentage of the largest row in its own group.
     min-width so a 0.25h row is still a visible mark rather than nothing at all. */
  .barwrap { background:var(--surface-2); border-radius:3px; overflow:hidden; margin-top:5px; height:6px; }
  .bar { height:6px; background:var(--accent); border-radius:3px; min-width:2px; }
  /* Numbers that get compared down a column must not wander. */
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; font-family:"JetBrains Mono",ui-monospace,monospace; }

  /* Interaction history: one line per touch, expandable */
  .hist { border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .hist-row { border-bottom:1px solid var(--line); font-size:14px; border-left:3px solid var(--line); }
  .hist-row:last-child { border-bottom:0; }
  /* Left-bar color by interaction type (Phase 4, 2026-09-14), matching the ContactRecord mockup. Purely
     additive — the <details>/<summary> collapse behavior below is unchanged. */
  .hist-row.accent { border-left-color:var(--accent); }
  .hist-row.green { border-left-color:var(--green); }
  .hist-row.amber { border-left-color:var(--amber); }
  .hist-row > summary, .hist-flat { padding:9px 12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; cursor:pointer; list-style:none; }
  .hist-flat { cursor:default; }
  .hist-row > summary::-webkit-details-marker { display:none; }
  .hist-row > summary:before { content:"▸"; color:var(--muted); font-size:11px; width:10px; flex:none; }
  .hist-row[open] > summary:before { content:"▾"; }
  .hist-flat:before { content:""; width:10px; flex:none; }
  .hist-row > summary:hover { background:var(--surface-2); }
  .hist-date { font-variant-numeric:tabular-nums; color:var(--muted); flex:none; font-family:"JetBrains Mono",ui-monospace,monospace; }
  .hist-subject { flex:1 1 200px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hist-detail { padding:2px 12px 14px 34px; border-top:1px dashed var(--line); background:var(--surface-2); }
  .hist-detail > div { margin:6px 0; }
  .hist-more { margin-top:8px; }
  .hist-more > summary { font-size:13px; color:var(--accent); cursor:pointer; padding:6px 0; }
`;

/*
 * Rail icons — hand-drawn, not a library. Nothing in package.json provides one today, and this app's
 * whole posture is zero-build-step and minimal-dependency; adding an icon package for 21 glyphs would
 * be a bigger addition than the glyphs themselves. Stroke-based, currentColor, one visual language, so
 * a rail item's color (muted / ink / accent depending on hover and active state) drives its icon for
 * free with no separate icon-color logic anywhere.
 */
const NAV_ICONS: Record<string, string> = {
  dashboard: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
  contacts: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/></svg>`,
  pipeline: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16l-6 8v6l-4-2v-4z"/></svg>`,
  actions: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/><path d="M8.5 14.5l2 2 4-4.5"/></svg>`,
  add: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9.5" cy="9" r="3.3"/><path d="M3.5 20c0-3.6 2.7-6 6-6"/><path d="M17.5 8.5v6M14.5 11.5h6"/></svg>`,
  templates: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16M4 5l4 5.5v6L14 18v-7.5L20 5"/></svg>`,
  meetings: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none"/></svg>`,
  analytics: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`,
  pursuits: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/></svg>`,
  customers: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M9 8V6a3 3 0 0 1 3-3v0a3 3 0 0 1 3 3v2"/></svg>`,
  pricing: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M8 18h2M12 18h4"/></svg>`,
  companies: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21V7l8-4 8 4v14"/><path d="M9 21v-6h6v6"/></svg>`,
  time: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>`,
  timereport: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 19V10M12 19V5M19 19v-7"/></svg>`,
  timeimport: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16"/><path d="M12 12v5m0 0l-2-2m2 2l2-2"/></svg>`,
  activities: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>`,
  import: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V5m0 0l-4 4m4-4l4 4"/><path d="M4 19h16"/></svg>`,
  email: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 6l9 7 9-7"/></svg>`,
  update: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/></svg>`,
  export: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v11m0 0l-4-4m4 4l4-4"/><path d="M4 19h16"/></svg>`,
  audit: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4.5"/></svg>`,
  health: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg>`,
  feedback: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v11H8l-4 4z"/></svg>`,
  settings: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  outreach: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/></svg>`,
  commitments: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>`,
  users: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.6 2.7-6 6-6s6 2.4 6 6"/><path d="M16 4.5a3.2 3.2 0 0 1 0 6.3M18 14.2c1.9.8 3 2.8 3 5.8"/></svg>`,
  account: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  signout: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>`,
};

/**
 * Dashboard section-header icons (Phase 2, 2026-09-14). Sections 1, 2 and 8 reuse an existing rail
 * icon rather than drawing a near-duplicate (a clock is a clock whether it labels "Time" in the rail or
 * "Upcoming Meetings" on the dashboard); the rest are new because nothing in NAV_ICONS represents them.
 */
export const SECTION_ICONS: Record<number, string> = {
  1: NAV_ICONS.time,
  2: NAV_ICONS.actions,
  3: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h11"/><path d="M13 6l6 6-6 6"/></svg>`,
  4: NAV_ICONS.feedback,
  5: NAV_ICONS.export,
  6: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>`,
  7: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4L2 20h20z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.6" fill="currentColor" stroke="none"/></svg>`,
  8: NAV_ICONS.pursuits,
};

interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof NAV_ICONS;
}
interface NavGroup {
  label?: string;
  items: NavItem[];
}

/*
 * Real full link set, regrouped by what the work actually is rather than by arrival order.
 *
 * "Pursuits", not "Pipeline", for this group — the flat nav's own comment already named this trap:
 * /pipeline is the RELATIONSHIP pipeline (contacts by stage) and /pursuits is the SALES pipeline (work
 * being chased). Naming this group "Pipeline" would collide with the real /pipeline link, which lives
 * under Relationships instead, where it functionally belongs.
 *
 * Time / Time Report / Time Import are promoted here from contextual-only links (reachable before only
 * via the dashboard's "hours logged" line or a Time page's own week-nav). A weekly-use workflow earns
 * primary nav; Activities — the vocabulary that workflow draws its categories from — joins it.
 */
const NAV_GROUPS: NavGroup[] = [
  { items: [{ href: "/", label: "Dashboard", icon: "dashboard" }] },
  {
    label: "Relationships",
    items: [
      { href: "/contacts", label: "Contacts", icon: "contacts" },
      { href: "/pipeline", label: "Pipeline", icon: "pipeline" },
      { href: "/actions", label: "Action Items", icon: "actions" },
      { href: "/commitments", label: "Commitments", icon: "commitments" },
      { href: "/outreach", label: "Outreach", icon: "outreach" },
      { href: "/meetings", label: "Meetings", icon: "meetings" },
      { href: "/analytics", label: "Analytics", icon: "analytics" },
      { href: "/contacts/new", label: "Add Contact", icon: "add" },
      { href: "/templates", label: "Templates", icon: "templates" },
    ],
  },
  {
    label: "Pursuits",
    items: [
      { href: "/pursuits", label: "Pursuits", icon: "pursuits" },
      { href: "/engagements", label: "Customers", icon: "customers" },
      { href: "/organizations", label: "Companies", icon: "companies" },
      { href: "/pricing", label: "Pricing", icon: "pricing" },
    ],
  },
  {
    label: "Time",
    items: [
      { href: "/time", label: "Time", icon: "time" },
      { href: "/time/report", label: "Time Report", icon: "timereport" },
      { href: "/time/import", label: "Time Import", icon: "timeimport" },
      { href: "/activities", label: "Activities", icon: "activities" },
    ],
  },
  {
    label: "Data",
    items: [
      { href: "/import", label: "Import", icon: "import" },
      { href: "/email/import", label: "Email", icon: "email" },
      { href: "/update", label: "Update", icon: "update" },
      { href: "/export", label: "Export", icon: "export" },
      { href: "/audit", label: "Audit", icon: "audit" },
      { href: "/health", label: "Health", icon: "health" },
      { href: "/users", label: "Users", icon: "users" },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

/**
 * Longest-prefix match against the real request path, so /contacts/123 highlights Contacts while the
 * more specific /contacts/new highlights Add Contact, and /time/report highlights Time Report rather
 * than Time. No call site hand-picks an id — a hardcoded string per route (34+ of them) would drift
 * from this table the first time someone added a route without updating both places.
 */
function activeHref(path: string): string | null {
  let best: string | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (path === item.href || path.startsWith(`${item.href}/`)) {
        if (!best || item.href.length > best.length) best = item.href;
      }
    }
  }
  return best;
}

function railLink(item: NavItem, active: string | null): string {
  return `<a class="rail-link${item.href === active ? " active" : ""}" href="${esc(item.href)}">${NAV_ICONS[item.icon]}${esc(item.label)}</a>`;
}

function railHtml(path: string, theme: "dark" | "light"): string {
  const active = activeHref(path);
  // Admin-only links (auth.ts ADMIN_ONLY) are left out for members, rather than shown and then refused.
  const admin = isAdmin();
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => admin || !adminOnlyPath(i.href)) }))
    .filter((g) => g.items.length)
    .map(
    (g) =>
      `<div class="rail-group">${g.label ? `<div class="rail-group-label">${esc(g.label)}</div>` : ""}${g.items
        .map((item) => railLink(item, active))
        .join("")}</div>`
  ).join("");
  const ret = encodeURIComponent(path);
  return `<aside class="rail">
  <div class="rail-brand"><a href="/">
    <img src="/logo.png${logoV()}" alt="" width="30" height="14" style="object-fit:contain">
    <b>${esc(appSettings().appName)}</b>
  </a></div>
  <nav class="rail-nav">${groups}</nav>
  <div class="rail-foot">
    <div class="theme-toggle">
      <a class="${theme === "dark" ? "active" : ""}" href="/theme/dark?return=${ret}">Dark</a>
      <a class="${theme === "light" ? "active" : ""}" href="/theme/light?return=${ret}">Light</a>
    </div>
    <a class="rail-link${path === "/account" ? " active" : ""}" href="/account" title="Signed in as ${esc(whoami().actor)}" aria-label="My account: ${esc(whoami().displayName)}">${NAV_ICONS.account}<span class="rail-me">${esc(whoami().displayName)}</span></a>
    <a class="rail-link" href="/feedback">${NAV_ICONS.feedback}Feedback</a>
    <a class="rail-link" href="/logout">${NAV_ICONS.signout}Sign Out</a>
  </div>
</aside>`;
}

/**
 * Show/Hide for password fields. Progressive: without JS the field is a normal hidden password input.
 * Hiding again on submit means a revealed password is never left on screen after a failed sign-in, and
 * the browser's password manager always sees a type=password field when it saves.
 */
const PW_TOGGLE_SCRIPT = `<script>
document.querySelectorAll('input[type=password]').forEach(function (inp) {
  var wrap = document.createElement('div');
  wrap.className = 'pw-wrap';
  inp.parentNode.insertBefore(wrap, inp);
  wrap.appendChild(inp);
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'pw-toggle';
  function set(show) {
    inp.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
    b.setAttribute('aria-pressed', show ? 'true' : 'false');
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }
  b.addEventListener('click', function () { set(inp.type === 'password'); inp.focus(); });
  if (inp.form) inp.form.addEventListener('submit', function () { set(false); });
  set(false);
  wrap.appendChild(b);
});
</script>`;

/*
 * Comments in this codebase are working notes, and some name real people, clients and decisions. HTML
 * and CSS comments would otherwise ship in every page's source (Phase 3a packaging, 2026-09-25), so they
 * are stripped on the way out. TypeScript comments never reach the browser.
 */
const STYLE_SHIPPED = STYLE.replace(/\/\*[\s\S]*?\*\//g, "");
const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");

export function layout(opts: {
  title: string;
  body: string;
  banner?: string;
  nav?: boolean;
  /**
   * Required, not optional — on purpose. `layout()` derives the active theme and the active rail item
   * from the real request, so it needs the request; making this optional would let a call site compile
   * without a theme or highlighting, silently. Required means `npm run typecheck` names every call site
   * that hasn't been updated, which is the actual completeness check for a change this wide.
   */
  c: Context<{ Bindings: Bindings }>;
}): string {
  const theme: "dark" | "light" = getCookie(opts.c, "pp_theme") === "light" ? "light" : "dark";
  const path = opts.c.req.path;
  // Phase 3b: admins see a banner on every page while database updates wait (not on Health, which
  // already leads with the panel that applies them).
  const pending = isAdmin() && path !== "/health" ? pendingCountCached() : 0;
  const updates = pending
    ? `<div class="flash warn" style="margin-bottom:12px">This copy's database has ${pending === 1 ? "an update" : `${pending} updates`} waiting. <a href="/health">Apply ${pending === 1 ? "it" : "them"} on Health</a>.</div>`
    : "";
  const content = `${updates}${opts.banner ?? ""}${opts.body}`;
  const shell = opts.nav === false ? content : `<div class="shell">${railHtml(path, theme)}<div class="main-area">${content}</div></div>`;
  return stripComments(`<!doctype html>
<html lang="en" data-theme="${theme}">
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
<link rel="apple-touch-icon" href="/apple-touch-icon.png${iconV()}">
<link rel="icon" type="image/png" href="/icon.png${iconV()}">
<meta name="theme-color" content="${theme === "light" ? "#f4f5f8" : "#0e1116"}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${esc(appSettings().shortName)}">
<!-- "black", not "black-translucent": translucent draws the page UNDER the status bar, which would put
     the clock on top of the header. Opaque keeps the layout honest. -->
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<!--
  Sora (UI text) and JetBrains Mono (dates/numbers) — this app's first external network reference in
  rendered HTML. Every font-family in STYLE keeps a real system fallback stack, so a slow or blocked
  request degrades invisibly rather than breaking a page; nothing here is load-bearing for content.
-->
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<title>${esc(opts.title)} · ${esc(appSettings().appName)}</title>
<style>${STYLE_SHIPPED}</style>
</head>
<body>${shell}${PW_TOGGLE_SCRIPT}</body>
</html>`);
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
 * that do carry minutes (the owner, 2026-07-30). This normalizes the display only: minutes are always
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
 * (the owner's question 2026-07-30).
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

/**
 * The same red/amber/green/grey classification followUpPill uses above, for the status dot on a
 * dashboard listrow (Phase 2). Kept as its own function rather than having followUpPill return its
 * color alongside its markup, since every other call site only ever wanted the rendered pill.
 */
export function followUpDotClass(date: string | null, stage?: string | null): "red" | "amber" | "green" | "grey" {
  if (!date) return "grey";
  if (stage && TERMINAL_STAGES.some((v) => v === stage)) return "grey";
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) return "amber";
  return dayDelta(date, today) < 0 ? "red" : "green";
}

/**
 * Two-letter initials for the dashboard's avatar circles (Phase 2) — "Renee Huang" → "RH". Nothing in
 * this app derived initials before now. First letter of the first two whitespace-separated words;
 * a single-word name (an organization entered as a contact, or a placeholder) falls back to its own
 * first letter rather than throwing or rendering blank.
 */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * The Stage dot color (Phase 3, 2026-09-14; lifted here in Phase 4 once the contact record needed the
 * same mapping the contacts list already had). Explicit per stage rather than derived from
 * ACTIVE_STAGES/TERMINAL_STAGES, so a 13th stage forces a deliberate choice here instead of silently
 * defaulting to something that might be wrong.
 */
const STAGE_DOT: Record<string, "accent" | "amber" | "green" | "grey"> = {
  meeting_scheduled: "accent",
  in_conversation: "accent",
  follow_up_action: "accent",
  awaiting_response: "amber",
  reach_out_later: "amber",
  not_contacted: "amber",
  stay_connected: "green",
  pray: "green",
};
for (const stage of TERMINAL_STAGES) STAGE_DOT[stage] = "grey";
export function stageDotClass(stage: string): "accent" | "amber" | "green" | "grey" {
  return STAGE_DOT[stage] ?? "grey";
}

/**
 * The "★ Priority" pill for an inner-circle contact (migration 0029), or "" for everyone else, so call
 * sites can interpolate it unconditionally. Takes anything carrying is_priority because the work lists
 * pass their own row shapes, not full Contacts.
 */
export function priorityBadge(r: { is_priority?: number | null }): string {
  return r.is_priority ? `<span class="pill prio" title="Priority contact">Priority</span>` : "";
}
