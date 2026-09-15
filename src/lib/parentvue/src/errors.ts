export type ParentVueErrorCode =
  | 'not_configured'
  | 'auth_failed'
  | 'network_error'
  | 'upstream_error'
  | 'parse_error';

/**
 * Typed error for ParentVUE API failures. Messages intentionally carry only
 * the method name and a failure class — never credentials, request bodies,
 * or upstream response payloads.
 */
export class ParentVueError extends Error {
  readonly code: ParentVueErrorCode;

  constructor(code: ParentVueErrorCode, message: string) {
    super(message);
    this.name = 'ParentVueError';
    this.code = code;
  }
}
