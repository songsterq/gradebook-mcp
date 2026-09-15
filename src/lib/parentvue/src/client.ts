import { ParentVueError } from './errors.js';
import {
  parseChildList,
  parseCourses,
  parseReportingPeriods,
  parseStudentInfo,
} from './parse.js';
import type { Child, CourseSnapshot, GradebookSnapshot, StudentInfo } from './parse.js';

export type { Child, GradebookSnapshot, StudentInfo };
export { ParentVueError };
export type { ParentVueErrorCode } from './errors.js';
export { deriveAssignmentStatus, normalizeDate } from './parse.js';
export type {
  AssignmentSnapshot,
  AssignmentStatus,
  CourseMark,
  CourseSnapshot,
  ReportingPeriod,
} from './parse.js';

export interface ParentVueClientOptions {
  /** District host, e.g. `district.edupoint.com` (no scheme, no path). */
  host: string;
  username: string;
  password: string;
  /**
   * Parent accounts enumerate children via `GetChildListData`; a student
   * login addresses its own record directly. Defaults to true.
   */
  parent?: boolean;
  /** Override for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  userAgent?: string;
}

const API_PATH = '/api/v1/mobile/PXPWebServices';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thin client for the ParentVUE / StudentVUE mobile JSON API
 * (`/api/v1/mobile/PXPWebServices`) — the same interface the current
 * ParentVUE and StudentVUE mobile apps use. Read-only: every method is a
 * data fetch.
 *
 * Auth is a token exchange: one `AttemptLogin` call (HTTP Basic) yields an
 * opaque bearer token that is reused until the server rejects it, at which
 * point the client re-authenticates once and retries.
 *
 * Credentials are used for the login exchange only and never logged; errors
 * carry a machine code plus a human message, never request or response
 * content.
 */
export class ParentVueClient {
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  private readonly parent: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private token: string | null = null;

  constructor(options: ParentVueClientOptions) {
    if (!options.host || !options.username || !options.password) {
      throw new ParentVueError('not_configured', 'ParentVUE host, username, and password are all required.');
    }
    this.host = options.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    this.username = options.username;
    this.password = options.password;
    this.parent = options.parent ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? 'parentvue/0.2.0';
  }

  /** Children on the parent account (parent logins), or the single student (student logins). */
  async listChildren(): Promise<Child[]> {
    return parseChildList(await this.api('GetChildListData', { childIntID: 0, languageCode: 'en' }));
  }

  /**
   * School/grade detail for one child. Costs a `GetChildListData` round trip:
   * callers that already hold a {@link Child} should call `parseStudentInfo`
   * on it instead, since the list response carries the same fields.
   */
  async getStudentInfo(childId: string): Promise<StudentInfo> {
    const child = (await this.listChildren()).find((c) => c.id === childId);
    if (!child) {
      throw new ParentVueError('upstream_error', 'ParentVUE account has no student with that id.');
    }
    return parseStudentInfo(child);
  }

  /**
   * Gradebook for one child across every reporting period the district
   * exposes, with per-period course marks and assignment rows. One API call
   * per reporting period; the first response also carries the period list.
   */
  async getGradebook(childId: string): Promise<GradebookSnapshot> {
    const childIntID = Number(childId);
    if (!Number.isInteger(childIntID) || childIntID < 0) {
      throw new ParentVueError('parse_error', 'Child id is not a valid ParentVUE childIntID.');
    }
    const first = await this.api('Gradebook', { reportPeriod: 0, childIntID, languageCode: 'en' });
    const firstBook = first?.traditionalGradebook ?? null;
    const reportingPeriods = firstBook ? parseReportingPeriods(firstBook) : [];
    const courses: CourseSnapshot[] = [];
    const completePeriodIndexes: number[] = [];
    for (const period of reportingPeriods) {
      const book =
        period.index === 0
          ? firstBook
          : ((await this.api('Gradebook', {
              reportPeriod: period.index,
              childIntID,
              languageCode: 'en',
            }))?.traditionalGradebook ?? null);
      if (book) {
        completePeriodIndexes.push(period.index);
        courses.push(...parseCourses(book, period, period.index));
      }
    }
    return { childId, reportingPeriods, courses, completePeriodIndexes };
  }

  /**
   * One authenticated API call. Returns the response `data` object, or null
   * for the benign-empty case (error 2100, e.g. a school that runs no
   * gradebook). Re-authenticates once and retries on a 401.
   */
  private async api(method: string, inner: Record<string, unknown>): Promise<any> {
    if (!this.token) this.token = await this.login();
    let json = await this.post(method, inner, `Bearer ${this.token}`);
    if (json?.error?.code === '401') {
      this.token = await this.login();
      json = await this.post(method, inner, `Bearer ${this.token}`);
    }
    const err = json?.error;
    if (err) {
      if (err.code === '2100') return null;
      if (err.code === '401' || /invalid user/i.test(err.message ?? '')) {
        throw new ParentVueError('auth_failed', `ParentVUE rejected the credentials for ${method}.`);
      }
      throw new ParentVueError('upstream_error', `ParentVUE reported error ${err.code} for ${method}.`);
    }
    return json?.data ?? null;
  }

  /** The login exchange: HTTP Basic in, opaque bearer token out. */
  private async login(): Promise<string> {
    const json = await this.post(
      'AttemptLogin',
      { userID: null, password: null, userType: this.parent ? 'parent' : 'student' },
      `Basic ${toBase64(`${this.username}:${this.password}`)}`,
    );
    if (json && typeof json.access_token === 'string' && json.access_token !== '') {
      return json.access_token;
    }
    if (json?.error?.code === '401' || /invalid user/i.test(json?.error?.message ?? '')) {
      throw new ParentVueError('auth_failed', 'ParentVUE rejected the login credentials.');
    }
    throw new ParentVueError('upstream_error', 'ParentVUE login did not return a session token.');
  }

  /** POST one double-encoded JSON envelope; return the parsed response body. */
  private async post(method: string, inner: Record<string, unknown>, authorization: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${this.host}${API_PATH}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
          'User-Agent': this.userAgent,
        },
        body: JSON.stringify({ arguments: { request: JSON.stringify(inner) } }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ParentVueError(
        'network_error',
        `Could not reach ParentVUE for ${method}: ${err instanceof Error ? err.name : 'fetch failed'}.`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      if (response.status === 401) return { error: { code: '401' }, data: null };
      throw new ParentVueError('upstream_error', `ParentVUE returned HTTP ${response.status} for ${method}.`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ParentVueError('parse_error', `ParentVUE returned a non-JSON response for ${method}.`);
    }
  }
}

function toBase64(value: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
