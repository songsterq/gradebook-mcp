import { z } from 'zod';

export const studentRef = z
  .string()
  .min(1)
  .describe('Student name (case-insensitive) or id (stu_...). Use gradebook_overview to find students.');

export const courseRef = z
  .string()
  .regex(/^crs_/, 'Use a course id beginning with crs_; get ids from gradebook_courses.')
  .describe('Course id (crs_...). Get ids from gradebook_courses.');

export const termRef = z.object({
  schoolYear: z
    .string()
    .regex(/^\d{4}-\d{4}$/, 'Use a school year like 2026-2027.')
    .optional()
    .describe('School year like 2026-2027; defaults to the latest term.'),
  reportingPeriod: z
    .string()
    .min(1)
    .optional()
    .describe('Reporting period name as shown by gradebook_terms; defaults to the latest term.'),
});

export const assignmentStatusFilter = z
  .enum(['missing', 'upcoming', 'scored', 'all'])
  .describe('missing: missing, incomplete, or late work; upcoming: not yet due; scored: has a score; all: everything.');

export type AssignmentStatusFilter = z.infer<typeof assignmentStatusFilter>;

export interface Student {
  id: string;
  parentvueId: string;
  name: string;
  school: string;
  gradeLevel: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Term {
  id: string;
  studentId: string;
  schoolYear: string;
  reportingPeriod: string;
  periodIndex: number;
  periodStart: string | null;
  periodEnd: string | null;
  lastSyncedAt: string | null;
  courseCount: number;
  missingCount: number;
}

export interface Course {
  id: string;
  termId: string;
  title: string;
  teacher: string | null;
  room: string | null;
  period: string | null;
  gradeLetter: string | null;
  gradeScore: number | null;
  missingCount: number;
  lastSyncedAt: string | null;
}

export type AssignmentStatus =
  | 'missing'
  | 'late'
  | 'incomplete'
  | 'collected'
  | 'not_due'
  | 'excused'
  | 'scored';

export interface Assignment {
  id: string;
  courseId: string;
  extKey: string;
  title: string;
  category: string | null;
  dueDate: string | null;
  pointsPossible: number | null;
  score: number | null;
  scoreRaw: string | null;
  scoreLetter: string | null;
  status: AssignmentStatus;
  notes: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  scoredAt: string | null;
  history?: ScorePoint[];
  stale: boolean;
}

export interface ScorePoint {
  observedAt: string;
  score: number | null;
  scoreRaw: string | null;
  scoreLetter: string | null;
  pointsPossible: number | null;
}

export type ScoreEvent = 'new_score' | 'rescored' | 'cleared';

export interface GradePoint {
  observedAt: string;
  gradeLetter: string | null;
  gradeScore: number | null;
}

export interface MissingAssignment extends Assignment {
  studentId: string;
  studentName: string;
  courseTitle: string;
  termLabel: string;
}

/**
 * What started a sync run. Recorded per run so the ledger answers "is the
 * scheduler actually firing?" on its own, rather than by inferring it from
 * timestamps. `unknown` is only ever the backfilled value on rows written
 * before the column existed.
 */
export type SyncTrigger = 'scheduled' | 'mcp' | 'dashboard' | 'unknown';

export const SYNC_TRIGGERS: readonly SyncTrigger[] = ['scheduled', 'mcp', 'dashboard', 'unknown'];

export interface SyncRunSummary {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: 'ok' | 'partial' | 'error' | 'not_configured';
  trigger: SyncTrigger;
  detail: Record<string, unknown>;
}

export interface GradebookStatus {
  configured: boolean;
  lastRun: SyncRunSummary | null;
  students: number;
  terms: number;
  courses: number;
  assignments: number;
}
