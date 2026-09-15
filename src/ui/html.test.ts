import { describe, expect, it } from 'vitest';
import { escapeHtml, html, raw } from './html.js';

describe('escapeHtml', () => {
  it('escapes every HTML-sensitive character', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('html', () => {
  it('escapes interpolated values', () => {
    expect(html`<p title="${`a&"'`}">${'<b>'}</p>`.__html).toBe(
      '<p title="a&amp;&quot;&#39;">&lt;b&gt;</p>',
    );
  });

  it('passes nested Html through verbatim', () => {
    expect(html`<main>${html`<strong>safe</strong>`}</main>`.__html).toBe(
      '<main><strong>safe</strong></main>',
    );
  });

  it('joins arrays using the same interpolation rules', () => {
    expect(html`<ul>${[html`<li>one</li>`, '<li>two</li>', raw('<li>three</li>')]}</ul>`.__html).toBe(
      '<ul><li>one</li>&lt;li&gt;two&lt;/li&gt;<li>three</li></ul>',
    );
  });

  it('renders null and undefined as empty strings', () => {
    expect(html`a${null}b${undefined}c`.__html).toBe('abc');
  });

  it('neutralizes an element injection payload', () => {
    const rendered = html`<p>${'<img src=x onerror=alert(1)>'}</p>`.__html;
    expect(rendered).toContain('&lt;img');
    expect(rendered).not.toContain('<img');
  });
});
