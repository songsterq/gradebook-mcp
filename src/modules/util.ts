import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function textResult(structuredContent: Record<string, unknown>, summary: string): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent,
  };
}

/** Civil date (YYYY-MM-DD) of `now` in the given IANA timezone. */
export function todayIsoDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
