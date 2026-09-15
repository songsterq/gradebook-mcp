import { ParentVueError } from '../../lib/parentvue/src/index.js';

export type GradebookErrorCode =
  | 'not_configured'
  | 'not_found'
  | 'invalid'
  | 'auth_failed'
  | 'network_error'
  | 'upstream_error'
  | 'parse_error'
  | 'store_error';

/**
 * Module-level error. Messages never carry credentials, request bodies, or
 * upstream response payloads — see ParentVueError for the same guarantee at
 * the API layer.
 */
export class GradebookError extends Error {
  readonly code: GradebookErrorCode;

  constructor(code: GradebookErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GradebookError';
    this.code = code;
  }

  static fromParentVue(err: ParentVueError, what: string): GradebookError {
    const code = err.code as GradebookErrorCode;
    return new GradebookError(code, `ParentVUE ${what} failed (${err.code}).`, { cause: err });
  }
}
