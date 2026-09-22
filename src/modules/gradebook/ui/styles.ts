/**
 * Gradebook-only stylesheet, served in its own nonce'd <style> by
 * `renderDocument`. It lives here rather than in the shared layout because the
 * dashboard's tables and chips have no counterpart in the shared shell — and it has
 * to live in a stylesheet at all because the page's CSP is `style-src
 * 'nonce-…'`, under which a `style="…"` attribute is dropped without warning.
 */
export const GRADEBOOK_STYLES = `
.gb {
  --gb-surface: #fff;
  --gb-surface-alt: #f4f6f9;
  --gb-border: #dfe4ea;
  --gb-text: #182026;
  --gb-muted: #5b6570;
  --gb-accent: #075fc4;
  --gb-hover: #eaf2fd;
  --gb-good-bg: #e2f3e8; --gb-good-fg: #17663a;
  --gb-info-bg: #e6f0fb; --gb-info-fg: #0a4c96;
  --gb-warn-bg: #fbf0d6; --gb-warn-fg: #79510a;
  --gb-bad-bg: #fce7e3;  --gb-bad-fg: #a1260d;
  --gb-flat-bg: #edf0f3; --gb-flat-fg: #4b5560;
}
@media (prefers-color-scheme: dark) {
  .gb {
    --gb-surface: #1b2229;
    --gb-surface-alt: #202931;
    --gb-border: #333f4a;
    --gb-text: #edf1f5;
    --gb-muted: #aab4bd;
    --gb-accent: #77b7ff;
    --gb-hover: #24313f;
    --gb-good-bg: #14301f; --gb-good-fg: #79d79c;
    --gb-info-bg: #12283f; --gb-info-fg: #8cc3ff;
    --gb-warn-bg: #352907; --gb-warn-fg: #ecc35e;
    --gb-bad-bg: #3a1a14;  --gb-bad-fg: #ff9e89;
    --gb-flat-bg: #2a333c; --gb-flat-fg: #b6c0c9;
  }
}

/* Five columns of assignment data need more than the shared shell's 48rem. */
.shell:has(.gb) { width: min(100%, 64rem); }

/* --- Page header ------------------------------------------------------- */
.gb-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 1rem; margin-bottom: 1.25rem; padding-bottom: 1rem;
  border-bottom: 1px solid var(--gb-border);
}
.gb-head h1 { margin: 0; font-size: clamp(1.5rem, 5vw, 2rem); letter-spacing: -.02em; }
.gb-subtitle { margin: .3rem 0 0; color: var(--gb-muted); font-size: .875rem; }
.gb-head form { margin: 0; flex: none; }
.gb-head button { min-height: 2.4rem; padding: .5rem .9rem; font-size: .875rem; font-weight: 600; }
.gb-head button[disabled] { opacity: .5; cursor: not-allowed; }

/* --- Toolbar (student / term / view pickers) --------------------------- */
.gb-toolbar { display: grid; gap: .45rem; margin-bottom: 1.25rem; }
.gb-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; }
.gb-bar-label {
  flex: none; width: 4.25rem; font-size: .6875rem; font-weight: 700;
  letter-spacing: .08em; text-transform: uppercase; color: var(--gb-muted);
}
.gb-tab {
  display: inline-flex; align-items: center; gap: .35rem;
  padding: .3rem .7rem; border: 1px solid var(--gb-border); border-radius: 999px;
  background: var(--gb-surface); color: var(--gb-accent);
  font-size: .8125rem; font-weight: 500; line-height: 1.5; text-decoration: none;
}
.gb-tab:hover { border-color: var(--gb-accent); background: var(--gb-hover); }
.gb-tab[aria-current] {
  background: var(--gb-accent); border-color: var(--gb-accent);
  color: #fff; font-weight: 650; cursor: default;
}
@media (prefers-color-scheme: dark) { .gb-tab[aria-current] { color: #0d1319; } }
.gb-tab-count {
  padding: 0 .35rem; border-radius: 999px; background: var(--gb-flat-bg);
  color: var(--gb-flat-fg); font-size: .6875rem; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.gb-tab[aria-current] .gb-tab-count { background: rgba(255,255,255,.25); color: inherit; }
.gb-year { margin-left: .2rem; font-size: .8125rem; color: var(--gb-muted); }

/* --- Course cards ------------------------------------------------------ */
.gb-courses { display: grid; gap: .75rem; }
.gb-course {
  border: 1px solid var(--gb-border); border-radius: .75rem;
  background: var(--gb-surface); overflow: hidden;
  box-shadow: 0 1px 2px rgba(16, 24, 32, .06);
}
.gb-course-head {
  display: flex; align-items: center; gap: .65rem; padding: .8rem 1rem;
}
.gb-course-id { flex: 1; min-width: 0; }
.gb-course-title {
  display: block; font-size: 1rem; font-weight: 650; letter-spacing: -.01em;
  color: var(--gb-text);
}
.gb-course-meta { display: block; margin-top: .1rem; font-size: .8125rem; color: var(--gb-muted); }
.gb-course-tags { display: flex; flex: none; align-items: center; gap: .4rem; }

/* --- Chips ------------------------------------------------------------- */
.gb-grade {
  display: inline-flex; align-items: baseline; gap: .3rem;
  padding: .2rem .55rem; border-radius: .45rem;
  background: var(--gb-flat-bg); color: var(--gb-flat-fg);
  font-size: .875rem; font-weight: 700; font-variant-numeric: tabular-nums;
}
.gb-grade[data-tone="good"] { background: var(--gb-good-bg); color: var(--gb-good-fg); }
.gb-grade[data-tone="info"] { background: var(--gb-info-bg); color: var(--gb-info-fg); }
.gb-grade[data-tone="warn"] { background: var(--gb-warn-bg); color: var(--gb-warn-fg); }
.gb-grade[data-tone="bad"]  { background: var(--gb-bad-bg);  color: var(--gb-bad-fg); }
.gb-grade-score { font-size: .75rem; font-weight: 600; opacity: .8; }
.gb-flag {
  display: inline-flex; align-items: center; padding: .2rem .55rem; border-radius: 999px;
  background: var(--gb-bad-bg); color: var(--gb-bad-fg);
  font-size: .75rem; font-weight: 700; white-space: nowrap;
}
.gb-status {
  display: inline-flex; align-items: center; gap: .35rem;
  padding: .15rem .5rem .15rem .45rem; border-radius: 999px;
  background: var(--gb-flat-bg); color: var(--gb-flat-fg);
  font-size: .75rem; font-weight: 600; white-space: nowrap;
}
.gb-status::before { content: ""; width: .4rem; height: .4rem; border-radius: 50%; background: currentColor; }
.gb-status[data-tone="good"] { background: var(--gb-good-bg); color: var(--gb-good-fg); }
.gb-status[data-tone="info"] { background: var(--gb-info-bg); color: var(--gb-info-fg); }
.gb-status[data-tone="warn"] { background: var(--gb-warn-bg); color: var(--gb-warn-fg); }
.gb-status[data-tone="bad"]  { background: var(--gb-bad-bg);  color: var(--gb-bad-fg); }
.gb-stale {
  margin-left: .35rem; padding: 0 .3rem; border: 1px solid var(--gb-border);
  border-radius: .3rem; font-size: .6875rem; color: var(--gb-muted);
}

/* --- Assignment table -------------------------------------------------- */
.gb-table-wrap { border-top: 1px solid var(--gb-border); overflow-x: auto; }
.gb-table { width: 100%; min-width: 40rem; border-collapse: collapse; font-size: .875rem; }
/* Fixed widths so every course card lines its columns up with every other one;
   ragged per-table sizing was the main thing making the page look unfinished. */
.gb-table--assignments { table-layout: fixed; }
.gb-table--assignments .gb-col-due { width: 5.5rem; }
.gb-table--assignments .gb-col-cat { width: 11rem; }
.gb-table--assignments .gb-col-score { width: 7rem; }
.gb-table--assignments .gb-col-status { width: 7.5rem; }
.gb-table th {
  padding: .5rem .85rem; background: var(--gb-surface-alt);
  border-bottom: 1px solid var(--gb-border);
  font-size: .6875rem; font-weight: 700; letter-spacing: .06em;
  text-transform: uppercase; text-align: left; color: var(--gb-muted); white-space: nowrap;
}
.gb-table td { padding: .55rem .85rem; border-bottom: 1px solid var(--gb-border); vertical-align: top; }
.gb-table tbody tr:nth-child(even) { background: var(--gb-surface-alt); }
/* After the zebra rule on purpose: equal specificity, so source order decides. */
.gb-table tbody tr:hover { background: var(--gb-hover); }
.gb-table tbody tr:last-child td { border-bottom: 0; }
/* An inset shadow rather than a border, so flagged rows keep the same padding. */
.gb-table tbody tr[data-flag] td:first-child { box-shadow: inset 3px 0 0 var(--gb-bad-fg); }
.gb-title-cell { font-weight: 550; color: var(--gb-text); min-width: 11rem; }
.gb-date { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--gb-muted); }
.gb-cat { color: var(--gb-muted); }
.gb-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.gb-score { font-weight: 650; }
.gb-trail { display: block; margin-top: .15rem; color: var(--gb-muted); font-size: .75rem; font-weight: 400; }
.gb-pct { margin-left: .3rem; font-size: .75rem; font-weight: 500; color: var(--gb-muted); }
.gb-dash { color: var(--gb-muted); }
.gb-empty { margin: 0; padding: .9rem 1rem; border-top: 1px solid var(--gb-border);
  color: var(--gb-muted); font-size: .875rem; }

/* --- Standalone panels (missing view, empty states) -------------------- */
.gb-panel {
  border: 1px solid var(--gb-border); border-radius: .75rem; background: var(--gb-surface);
  overflow: hidden; box-shadow: 0 1px 2px rgba(16, 24, 32, .06);
}
.gb-panel > .gb-table-wrap { border-top: 0; }
.gb-note { margin: 0; padding: 1.25rem 1rem; text-align: center; color: var(--gb-muted); }

/* --- Footer ------------------------------------------------------------ */
.gb-foot {
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: .35rem 1rem;
  margin-top: 1.5rem; padding-top: .85rem; border-top: 1px solid var(--gb-border);
  font-size: .75rem; color: var(--gb-muted);
}
.gb-foot p { margin: 0; }

@media (max-width: 36rem) {
  /* The narrowest useful table: category is the one column also shown, in full,
     by the missing-work view. */
  .gb-col-cat { display: none; }
  /* Fixed widths total more than a phone is wide, which collapses the title
     column to nothing — let the browser size the four remaining columns. */
  .gb-table { min-width: 0; }
  .gb-table--assignments { table-layout: auto; }
  .gb-table--assignments .gb-col-due,
  .gb-table--assignments .gb-col-score,
  .gb-table--assignments .gb-col-status { width: auto; }
  .gb-table th, .gb-table td { padding-left: .6rem; padding-right: .6rem; }
  .gb-title-cell { min-width: 0; }
  .gb-bar-label { width: 100%; }
  .gb-course-head { align-items: flex-start; }
}
`;
