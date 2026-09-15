/**
 * parentvue — a tiny, dependency-free client for the ParentVUE / StudentVUE
 * mobile JSON API (`/api/v1/mobile/PXPWebServices`), the same interface the
 * current ParentVUE and StudentVUE mobile apps use.
 *
 * Read-only by design: every method fetches data, nothing writes back to the
 * district.
 *
 * Live-verified against a Synergy district on an `*.edupoint.com` host on
 * 2026-09-13: AttemptLogin, GetChildListData, and Gradebook all return data
 * through this client.
 */
export { ParentVueClient } from './client.js';
export type { ParentVueClientOptions } from './client.js';
export { ParentVueError } from './errors.js';
export type { ParentVueErrorCode } from './errors.js';
export {
  deriveAssignmentStatus,
  normalizeDate,
  parseChildList,
  parseCourses,
  parseReportingPeriods,
  parseStudentInfo,
} from './parse.js';
export type {
  AssignmentSnapshot,
  AssignmentStatus,
  Child,
  CourseMark,
  CourseSnapshot,
  GradebookSnapshot,
  ReportingPeriod,
  StudentInfo,
} from './parse.js';
