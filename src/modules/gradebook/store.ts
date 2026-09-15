import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { withTransaction } from '../../storage/sqlite.js';
import { GradebookError } from './errors.js';
import { newId } from './logic.js';
import type {
  Assignment,
  AssignmentStatus,
  AssignmentStatusFilter,
  Course,
  GradePoint,
  MissingAssignment,
  Student,
  SyncRunSummary,
  SyncTrigger,
  Term,
} from './schema.js';

type RawRow = Record<string, unknown>;

const ACTIONABLE_STATUSES: AssignmentStatus[] = ['missing', 'incomplete', 'late'];

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toStudent(row: RawRow): Student {
  return {
    id: String(row['id']),
    parentvueId: String(row['parentvue_id']),
    name: String(row['name']),
    school: String(row['school']),
    gradeLevel: str(row['grade_level']),
    firstSeenAt: String(row['first_seen_at']),
    lastSeenAt: String(row['last_seen_at']),
  };
}

const TERM_WITH_COUNTS = `
  SELECT t.*,
    (SELECT COUNT(*) FROM courses c WHERE c.term_id = t.id AND c.stale = 0) AS course_count,
    (SELECT COALESCE(SUM(c.missing_count), 0) FROM courses c WHERE c.term_id = t.id AND c.stale = 0) AS missing_count
  FROM terms t
`;

/**
 * "Which term is the student actually in right now?", answered entirely from
 * the reporting-period dates the district publishes — never from a hardcoded
 * calendar. Terms rank: in progress today, then already finished (most
 * recently started first), then undated, then still to come (soonest first).
 * A tie on start date goes to the narrower window, so a district that
 * advertises an umbrella semester alongside its quarters resolves to the
 * quarter, which is where the live assignments are.
 */
const CURRENT_TERM_ORDER = `
  CASE
    WHEN t.period_start IS NULL THEN 2
    WHEN t.period_start <= ? AND COALESCE(t.period_end, '9999-12-31') >= ? THEN 0
    WHEN t.period_start <= ? THEN 1
    ELSE 3
  END,
  CASE WHEN t.period_start <= ? THEN t.period_start END DESC,
  CASE WHEN t.period_start <= ? THEN COALESCE(t.period_end, '9999-12-31') END ASC,
  CASE WHEN t.period_start > ? THEN t.period_start END ASC,
  t.school_year DESC,
  t.period_index DESC
`;

/** Number of `?` placeholders {@link CURRENT_TERM_ORDER} binds, all of them today's date. */
const CURRENT_TERM_ORDER_PARAMS = 6;

function toTerm(row: RawRow): Term {
  return {
    id: String(row['id']),
    studentId: String(row['student_id']),
    schoolYear: String(row['school_year']),
    reportingPeriod: String(row['reporting_period']),
    periodIndex: Number(row['period_index'] ?? 0),
    periodStart: str(row['period_start']),
    periodEnd: str(row['period_end']),
    lastSyncedAt: str(row['last_synced_at']),
    courseCount: Number(row['course_count'] ?? 0),
    missingCount: Number(row['missing_count'] ?? 0),
  };
}

function toCourse(row: RawRow): Course {
  return {
    id: String(row['id']),
    termId: String(row['term_id']),
    title: String(row['title']),
    teacher: str(row['teacher']),
    room: str(row['room']),
    period: str(row['period']),
    gradeLetter: str(row['grade_letter']),
    gradeScore: num(row['grade_score']),
    missingCount: Number(row['missing_count'] ?? 0),
    lastSyncedAt: str(row['last_synced_at']),
  };
}

function toAssignment(row: RawRow): Assignment {
  return {
    id: String(row['id']),
    courseId: String(row['course_id']),
    extKey: String(row['ext_key']),
    title: String(row['title']),
    category: str(row['category']),
    dueDate: str(row['due_date']),
    pointsPossible: num(row['points_possible']),
    score: num(row['score']),
    scoreRaw: str(row['score_raw']),
    scoreLetter: str(row['score_letter']),
    status: String(row['status']) as AssignmentStatus,
    notes: str(row['notes']),
    firstSeenAt: String(row['first_seen_at']),
    lastSeenAt: String(row['last_seen_at']),
    stale: Number(row['stale']) === 1,
  };
}

function toSyncRun(row: RawRow): SyncRunSummary {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(String(row['detail'] ?? '{}')) as Record<string, unknown>;
  } catch {
    detail = {};
  }
  return {
    id: Number(row['id']),
    startedAt: String(row['started_at']),
    finishedAt: str(row['finished_at']),
    status: String(row['status']) as SyncRunSummary['status'],
    trigger: String(row['triggered_by'] ?? 'unknown') as SyncRunSummary['trigger'],
    detail,
  };
}

/** Stable fallback identity when the feed provides no assignment id. */
export function fallbackExtKey(courseTitle: string, title: string, dueDate: string | null): string {
  const hash = createHash('sha256')
    .update(`${courseTitle}\n${title}\n${dueDate ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  return `fb:${hash}`;
}

export interface UpsertStudentInput {
  parentvueId: string;
  name: string;
  school: string;
  gradeLevel?: string | null;
}

export interface UpsertTermInput {
  studentId: string;
  schoolYear: string;
  reportingPeriod: string;
  periodIndex: number;
  periodStart?: string | null;
  periodEnd?: string | null;
}

export interface UpsertCourseInput {
  termId: string;
  title: string;
  teacher?: string | null;
  room?: string | null;
  period?: string | null;
  gradeLetter?: string | null;
  gradeScore?: number | null;
}

export interface UpsertAssignmentInput {
  courseId: string;
  extKey: string;
  title: string;
  category?: string | null;
  dueDate?: string | null;
  pointsPossible?: number | null;
  score?: number | null;
  scoreRaw?: string | null;
  scoreLetter?: string | null;
  status: AssignmentStatus;
  notes?: string | null;
}

export class GradebookStore {
  constructor(private readonly db: DatabaseSync) {}

  // -- reads -----------------------------------------------------------

  listStudents(): Student[] {
    return (this.db.prepare('SELECT * FROM students ORDER BY name').all() as RawRow[]).map(toStudent);
  }

  resolveStudent(ref: string): Student {
    const row = this.db
      .prepare('SELECT * FROM students WHERE id = ? OR lower(name) = lower(?)')
      .get(ref, ref) as RawRow | undefined;
    if (!row) throw new GradebookError('not_found', `No student matches '${ref}'.`);
    return toStudent(row);
  }

  latestTerm(studentId: string, todayYmd = new Date().toISOString().slice(0, 10)): Term | null {
    const row = this.db
      .prepare(
        `${TERM_WITH_COUNTS} WHERE t.student_id = ? ORDER BY ${CURRENT_TERM_ORDER} LIMIT 1`,
      )
      .get(studentId, ...new Array<string>(CURRENT_TERM_ORDER_PARAMS).fill(todayYmd)) as
      | RawRow
      | undefined;
    return row ? toTerm(row) : null;
  }

  terms(studentId: string): Term[] {
    return (
      this.db
        .prepare(`${TERM_WITH_COUNTS} WHERE t.student_id = ? ORDER BY t.school_year DESC, t.period_index DESC`)
        .all(studentId) as RawRow[]
    ).map(toTerm);
  }

  resolveTerm(studentId: string, schoolYear?: string, reportingPeriod?: string): Term {
    if (schoolYear === undefined && reportingPeriod === undefined) {
      const term = this.latestTerm(studentId);
      if (!term) throw new GradebookError('not_found', 'This student has no synced terms yet.');
      return term;
    }
    const conditions: string[] = ['t.student_id = ?'];
    const params: SQLInputValue[] = [studentId];
    if (schoolYear !== undefined) {
      conditions.push('t.school_year = ?');
      params.push(schoolYear);
    }
    if (reportingPeriod !== undefined) {
      conditions.push('lower(t.reporting_period) = lower(?)');
      params.push(reportingPeriod);
    }
    const row = this.db
      .prepare(`${TERM_WITH_COUNTS} WHERE ${conditions.join(' AND ')} ORDER BY t.period_index DESC LIMIT 1`)
      .get(...params) as RawRow | undefined;
    if (!row) throw new GradebookError('not_found', 'No term matches that school year / reporting period.');
    return toTerm(row);
  }

  courses(termId: string): Course[] {
    return (
      this.db.prepare('SELECT * FROM courses WHERE term_id = ? AND stale = 0 ORDER BY title').all(termId) as RawRow[]
    ).map(toCourse);
  }

  resolveCourse(id: string): { course: Course; term: Term; student: Student } {
    const courseRow = this.db.prepare('SELECT * FROM courses WHERE id = ? AND stale = 0').get(id) as RawRow | undefined;
    if (!courseRow) throw new GradebookError('not_found', `No course matches '${id}'.`);
    const course = toCourse(courseRow);
    const termRow = this.db.prepare('SELECT * FROM terms WHERE id = ?').get(course.termId) as RawRow | undefined;
    if (!termRow) throw new GradebookError('not_found', 'Course term is missing.');
    const studentRow = this.db
      .prepare('SELECT * FROM students WHERE id = ?')
      .get(String(termRow['student_id'])) as RawRow | undefined;
    if (!studentRow) throw new GradebookError('not_found', 'Course student is missing.');
    return { course, term: toTerm({ ...termRow, course_count: 0, missing_count: 0 }), student: toStudent(studentRow) };
  }

  assignments(courseId: string, filter: AssignmentStatusFilter): Assignment[] {
    let where = 'course_id = ?';
    const params: SQLInputValue[] = [courseId];
    if (filter === 'missing') {
      where += ` AND status IN (${ACTIONABLE_STATUSES.map((s) => `'${s}'`).join(',')}) AND stale = 0`;
    } else if (filter === 'upcoming') {
      where += ` AND status = 'not_due' AND stale = 0`;
    } else if (filter === 'scored') {
      where += ` AND status = 'scored' AND stale = 0`;
    }
    return (
      this.db
        .prepare(`SELECT * FROM assignments WHERE ${where} ORDER BY due_date IS NULL, due_date, title`)
        .all(...params) as RawRow[]
    ).map(toAssignment);
  }

  /**
   * Actionable missing work for one student or all students. Scoped to one
   * term when `termId` is given (what the dashboard's term picker wants),
   * otherwise to each student's latest term (what "what's missing now"
   * means for the MCP tools).
   */
  missing(
    studentId?: string,
    termId?: string,
    todayYmd = new Date().toISOString().slice(0, 10),
  ): MissingAssignment[] {
    const actionable = ACTIONABLE_STATUSES.map((s) => `'${s}'`).join(',');
    const params: SQLInputValue[] = [];
    let studentFilter = '';
    if (studentId !== undefined) {
      studentFilter = 'AND s.id = ?';
      params.push(studentId);
    }
    const termIds = termId !== undefined
      ? [termId]
      : studentId !== undefined
        ? [this.latestTerm(studentId, todayYmd)?.id].filter((id): id is string => id !== undefined)
        : this.listStudents()
            .map((student) => this.latestTerm(student.id, todayYmd)?.id)
            .filter((id): id is string => id !== undefined);
    if (termIds.length === 0) return [];
    const termFilter = `AND t.id IN (${termIds.map(() => '?').join(',')})`;
    params.push(...termIds);
    const rows = this.db
      .prepare(
        `SELECT a.*, c.title AS course_title, s.id AS student_id, s.name AS student_name,
                t.school_year AS school_year, t.reporting_period AS reporting_period
         FROM assignments a
         JOIN courses c ON c.id = a.course_id
         JOIN terms t ON t.id = c.term_id
         JOIN students s ON s.id = t.student_id
         WHERE a.status IN (${actionable}) AND a.stale = 0 AND c.stale = 0 ${studentFilter}
           ${termFilter}
         ORDER BY a.due_date IS NULL, a.due_date, s.name, c.title`,
      )
      .all(...params) as RawRow[];
    return rows.map((row) => ({
      ...toAssignment(row),
      studentId: String(row['student_id']),
      studentName: String(row['student_name']),
      courseTitle: String(row['course_title']),
      termLabel: `${row['school_year']} · ${row['reporting_period']}`,
    }));
  }

  trend(courseId: string): GradePoint[] {
    return (
      this.db
        .prepare('SELECT observed_at, grade_letter, grade_score FROM grade_history WHERE course_id = ? ORDER BY observed_at')
        .all(courseId) as RawRow[]
    ).map((row) => ({
      observedAt: String(row['observed_at']),
      gradeLetter: str(row['grade_letter']),
      gradeScore: num(row['grade_score']),
    }));
  }

  lastSyncRun(): SyncRunSummary | null {
    const row = this.db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as RawRow | undefined;
    return row ? toSyncRun(row) : null;
  }

  counts(): { students: number; terms: number; courses: number; assignments: number } {
    const one = (sql: string): number =>
      Number((this.db.prepare(sql).get() as RawRow)['n'] ?? 0);
    return {
      students: one('SELECT COUNT(*) AS n FROM students'),
      terms: one('SELECT COUNT(*) AS n FROM terms'),
      courses: one('SELECT COUNT(*) AS n FROM courses'),
      assignments: one('SELECT COUNT(*) AS n FROM assignments'),
    };
  }

  // -- sync writes -----------------------------------------------------

  upsertStudent(input: UpsertStudentInput, now: string): { id: string; created: boolean } {
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT id FROM students WHERE parentvue_id = ?')
        .get(input.parentvueId) as RawRow | undefined;
      if (existing) {
        this.db
          .prepare('UPDATE students SET name = ?, school = ?, grade_level = ?, last_seen_at = ? WHERE id = ?')
          .run(input.name, input.school, input.gradeLevel ?? null, now, String(existing['id']));
        return { id: String(existing['id']), created: false };
      }
      const id = newId('stu');
      this.db
        .prepare(
          'INSERT INTO students (id, parentvue_id, name, school, grade_level, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(id, input.parentvueId, input.name, input.school, input.gradeLevel ?? null, now, now);
      return { id, created: true };
    });
  }

  upsertTerm(input: UpsertTermInput, now: string): { id: string; created: boolean } {
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT id FROM terms WHERE student_id = ? AND school_year = ? AND reporting_period = ?')
        .get(input.studentId, input.schoolYear, input.reportingPeriod) as RawRow | undefined;
      if (existing) {
        const id = String(existing['id']);
        this.db
          .prepare(
            'UPDATE terms SET period_index = ?, period_start = ?, period_end = ?, last_synced_at = ? WHERE id = ?',
          )
          .run(input.periodIndex, input.periodStart ?? null, input.periodEnd ?? null, now, id);
        return { id, created: false };
      }
      const id = newId('trm');
      this.db
        .prepare(
          'INSERT INTO terms (id, student_id, school_year, reporting_period, period_index, period_start, period_end, last_synced_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.studentId,
          input.schoolYear,
          input.reportingPeriod,
          input.periodIndex,
          input.periodStart ?? null,
          input.periodEnd ?? null,
          now,
        );
      return { id, created: true };
    });
  }

  /**
   * Upsert a course row for one term. Returns the id and, when the posted
   * grade changed (including first observation), the before/after pair so the
   * caller can append to grade_history exactly once.
   */
  upsertCourse(
    input: UpsertCourseInput,
    now: string,
  ): { id: string; gradeChanged: { before: { letter: string | null; score: number | null }; after: { letter: string | null; score: number | null } } | null } {
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT * FROM courses WHERE term_id = ? AND title = ?')
        .get(input.termId, input.title) as RawRow | undefined;
      const letter = input.gradeLetter ?? null;
      const score = input.gradeScore ?? null;
      if (existing) {
        const id = String(existing['id']);
        const before = { letter: str(existing['grade_letter']), score: num(existing['grade_score']) };
        const changed = before.letter !== letter || before.score !== score;
        const everObserved =
          (this.db.prepare('SELECT COUNT(*) AS n FROM grade_history WHERE course_id = ?').get(id) as RawRow)['n'] as number;
        this.db
          .prepare(
            'UPDATE courses SET teacher = ?, room = ?, period = ?, grade_letter = ?, grade_score = ?, last_synced_at = ?, stale = 0 WHERE id = ?',
          )
          .run(input.teacher ?? null, input.room ?? null, input.period ?? null, letter, score, now, id);
        return {
          id,
          gradeChanged: changed || everObserved === 0 ? { before, after: { letter, score } } : null,
        };
      }
      const id = newId('crs');
      this.db
        .prepare(
          'INSERT INTO courses (id, term_id, title, teacher, room, period, grade_letter, grade_score, missing_count, last_synced_at) VALUES (?,?,?,?,?,?,?,?,0,?)',
        )
        .run(id, input.termId, input.title, input.teacher ?? null, input.room ?? null, input.period ?? null, letter, score, now);
      return { id, gradeChanged: { before: { letter: null, score: null }, after: { letter, score } } };
    });
  }

  appendGradeHistory(courseId: string, observedAt: string, letter: string | null, score: number | null): void {
    this.db
      .prepare('INSERT INTO grade_history (course_id, observed_at, grade_letter, grade_score) VALUES (?,?,?,?)')
      .run(courseId, observedAt, letter, score);
  }

  upsertAssignment(
    input: UpsertAssignmentInput,
    now: string,
  ): { id: string; created: boolean; becameActionable: boolean } {
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT * FROM assignments WHERE course_id = ? AND ext_key = ?')
        .get(input.courseId, input.extKey) as RawRow | undefined;
      if (existing) {
        const id = String(existing['id']);
        const wasActionable = (ACTIONABLE_STATUSES as string[]).includes(String(existing['status']));
        const isActionable = (ACTIONABLE_STATUSES as string[]).includes(input.status);
        this.db
          .prepare(
            `UPDATE assignments SET title = ?, category = ?, due_date = ?, points_possible = ?,
             score = ?, score_raw = ?, score_letter = ?, status = ?, notes = ?,
             last_seen_at = ?, stale = 0 WHERE id = ?`,
          )
          .run(
            input.title,
            input.category ?? null,
            input.dueDate ?? null,
            input.pointsPossible ?? null,
            input.score ?? null,
            input.scoreRaw ?? null,
            input.scoreLetter ?? null,
            input.status,
            input.notes ?? null,
            now,
            id,
          );
        return { id, created: false, becameActionable: !wasActionable && isActionable };
      }
      const id = newId('asn');
      this.db
        .prepare(
          `INSERT INTO assignments (id, course_id, ext_key, title, category, due_date, points_possible,
           score, score_raw, score_letter, status, notes, first_seen_at, last_seen_at, stale)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .run(
          id,
          input.courseId,
          input.extKey,
          input.title,
          input.category ?? null,
          input.dueDate ?? null,
          input.pointsPossible ?? null,
          input.score ?? null,
          input.scoreRaw ?? null,
          input.scoreLetter ?? null,
          input.status,
          input.notes ?? null,
          now,
          now,
        );
      return {
        id,
        created: true,
        becameActionable: (ACTIONABLE_STATUSES as string[]).includes(input.status),
      };
    });
  }

  /** Mark assignments of a course that were absent from the latest snapshot as stale. */
  markStaleAssignments(courseId: string, seenExtKeys: ReadonlySet<string>): number {
    const seen = [...seenExtKeys];
    const placeholders = seen.map(() => '?').join(',');
    const notSeen = seen.length > 0 ? `AND ext_key NOT IN (${placeholders})` : '';
    const result = this.db
      .prepare(`UPDATE assignments SET stale = 1 WHERE course_id = ? AND stale = 0 ${notSeen}`)
      .run(courseId, ...seen);
    return Number(result.changes);
  }

  /** Hide courses absent from a successfully fetched term and stale their assignments. */
  markStaleCourses(termId: string, seenTitles: ReadonlySet<string>): number {
    return withTransaction(this.db, () => {
      const seen = [...seenTitles];
      const placeholders = seen.map(() => '?').join(',');
      const notSeen = seen.length > 0 ? `AND title NOT IN (${placeholders})` : '';
      const assignments = this.db
        .prepare(
          `UPDATE assignments SET stale = 1
           WHERE stale = 0 AND course_id IN (
             SELECT id FROM courses WHERE term_id = ? ${notSeen}
           )`,
        )
        .run(termId, ...seen);
      this.db
        .prepare(`UPDATE courses SET stale = 1, missing_count = 0 WHERE term_id = ? AND stale = 0 ${notSeen}`)
        .run(termId, ...seen);
      return Number(assignments.changes);
    });
  }

  recomputeMissingCount(courseId: string): number {
    const count = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM assignments WHERE course_id = ? AND stale = 0 AND status IN (${ACTIONABLE_STATUSES.map((s) => `'${s}'`).join(',')})`,
          )
          .get(courseId) as RawRow
      )['n'] ?? 0,
    );
    this.db.prepare('UPDATE courses SET missing_count = ? WHERE id = ?').run(count, courseId);
    return count;
  }

  /** `trigger` is required, not defaulted: a run whose origin nobody recorded is
   *  exactly the ambiguity this column exists to remove. */
  beginSyncRun(startedAt: string, trigger: SyncTrigger): number {
    const result = this.db
      .prepare(
        `INSERT INTO sync_runs (started_at, finished_at, status, triggered_by, detail) VALUES (?, NULL, 'error', ?, '{}')`,
      )
      .run(startedAt, trigger);
    return Number(result.lastInsertRowid);
  }

  /** Most recent run started by `trigger`. Lets a caller ask specifically whether
   *  the scheduler has ever fired, independent of manual syncs. */
  lastSyncRunBy(trigger: SyncTrigger): SyncRunSummary | null {
    const row = this.db
      .prepare('SELECT * FROM sync_runs WHERE triggered_by = ? ORDER BY id DESC LIMIT 1')
      .get(trigger) as RawRow | undefined;
    return row ? toSyncRun(row) : null;
  }

  /** `finishedAt` is passed in rather than read from the clock, so callers stay deterministic under test. */
  finishSyncRun(
    id: number,
    status: SyncRunSummary['status'],
    detail: Record<string, unknown>,
    finishedAt: Date = new Date(),
  ): void {
    this.db
      .prepare('UPDATE sync_runs SET finished_at = ?, status = ?, detail = ? WHERE id = ?')
      .run(finishedAt.toISOString(), status, JSON.stringify(detail), id);
  }
}
