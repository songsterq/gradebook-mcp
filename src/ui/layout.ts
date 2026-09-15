import type { Html } from './html.js';
import { escapeHtml } from './html.js';

const STYLES = `
:root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f7f8; color: #182026; font-size: 1rem; line-height: 1.5; }
a { color: #075fc4; }
.shell { width: min(100%, 48rem); margin: 0 auto; padding: 1rem; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
h1, h2 { line-height: 1.2; }
h1 { margin: 0; font-size: clamp(1.5rem, 7vw, 2.25rem); }
.banner:empty { display: none; }
.banner { margin-bottom: 1rem; padding: .8rem 1rem; border: 2px solid #9a6200; border-radius: .75rem; background: #fff3cd; color: #4d3400; }
.card { margin-bottom: .75rem; padding: 1rem; border: 1px solid #d8dde2; border-radius: .8rem; background: #fff; }
.stack { display: grid; gap: .75rem; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
button, input, select { min-height: 2.75rem; border: 1px solid #8a949e; border-radius: .55rem; font: inherit; }
button { padding: .65rem 1rem; background: #075fc4; color: #fff; border-color: #075fc4; cursor: pointer; touch-action: manipulation; }
button[disabled] { opacity: .55; cursor: not-allowed; }
input, select { width: 100%; padding: .6rem .75rem; background: #fff; color: #182026; }
.muted { color: #5b6570; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (min-width: 40rem) {
  .shell { padding: 2rem; }
}
@media (prefers-color-scheme: dark) {
  body { background: #11161b; color: #edf1f5; }
  a { color: #77b7ff; }
  .card { background: #1b2229; border-color: #3a4650; }
  .banner { background: #493709; color: #fff0bd; border-color: #dca62b; }
  input, select { background: #151b20; color: #edf1f5; border-color: #66727d; }
  .muted { color: #aab4bd; }
}
`;

export interface DocumentOptions {
  title: string;
  nonce: string;
  banner?: Html;
  body: Html;
  /** Page-specific CSS, appended after the shared sheet. Author-controlled only:
   *  it is emitted verbatim into a <style>, so store data must never reach it. */
  styles?: string;
}

export function renderDocument({ title, nonce, banner, body, styles }: DocumentOptions): string {
  const safeTitle = escapeHtml(title);
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style nonce="${safeNonce}">${STYLES}</style>
  ${styles ? `<style nonce="${safeNonce}">${styles}</style>` : ''}
</head>
<body>
  <div class="shell">
    <div class="banner" data-banner role="status" tabindex="-1">${banner?.__html ?? ''}</div>
    ${body.__html}
  </div>
</body>
</html>`;
}
