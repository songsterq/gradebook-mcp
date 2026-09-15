/**
 * Interpolation rules:
 * 1. Interpolate only into element content or double-quoted attribute values —
 *    never into a <script>/<style> body, an unquoted attribute, or a URL-scheme position.
 * 2. URL path segments get encodeURIComponent before interpolation.
 * 3. raw() is only for composed Html from our own render functions — grep-able,
 *    never applied to store data.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export interface Html {
  readonly __html: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

export function raw(value: string): Html {
  return { __html: value };
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (typeof value === 'object' && '__html' in value) {
    const candidate = value as { __html?: unknown };
    if (typeof candidate.__html === 'string') return candidate.__html;
  }
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let rendered = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    rendered += renderValue(values[index]);
    rendered += strings[index + 1] ?? '';
  }
  return raw(rendered);
}
