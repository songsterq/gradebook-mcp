import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { withTransaction } from '../../storage/sqlite.js';
import { GradebookError } from './errors.js';
import { newId, scoreKey } from './logic.js';
import type {
  Assignment,
  AssignmentStatus,
  AssignmentStatusFilter,
  Course,
  GradePoint,
  MissingAssignment,
  ScoreEvent,
  ScorePoint,
  Student,
  SyncRunSummary,
  SyncTrigger,
  Term,
  WhatsNew,
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
    (SELECT COUNT(*) FROM course_marks cm WHERE cm.term_id = t.id AND cm.stale = 0) AS course_count,
    (SELECT COALESCE(SUM(cm.missing_count), 0) FROM course_marks cm WHERE cm.term_id = t.id AND cm.stale = 0) AS missing_count
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
    scoredAt: str(row['scored_at']),
    missingAt: str(row['missing_at']),
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
  studentId: string;
  schoolYear: string;
  title: string;
  teacher?: string | null;
  room?: string | null;
  period?: string | null;
}

export interface UpsertCourseMarkInput {
  courseId: string;
  termId: string;
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
      this.db.prepare(`
        SELECT c.id, cm.term_id, c.title, c.teacher, c.room, c.period,
               cm.grade_letter, cm.grade_score, cm.missing_count, c.last_synced_at
        FROM courses c
        JOIN course_marks cm ON cm.course_id = c.id
        WHERE cm.term_id = ? AND cm.stale = 0 AND c.stale = 0
        ORDER BY c.title
      `).all(termId) as RawRow[]
    ).map(toCourse);
  }

  resolveCourse(id: string): { course: Course; term: Term; student: Student } {
    const todayYmd = new Date().toISOString().slice(0, 10);
    const courseRow = this.db.prepare(`
      SELECT c.id, cm.term_id, c.title, c.teacher, c.room, c.period,
             cm.grade_letter, cm.grade_score, cm.missing_count, c.last_synced_at
      FROM courses c
      JOIN course_marks cm ON cm.course_id = c.id
      JOIN terms t ON t.id = cm.term_id
      WHERE c.id = ? AND c.stale = 0 AND cm.stale = 0
      ORDER BY ${CURRENT_TERM_ORDER}
      LIMIT 1
    `).get(id, ...new Array<string>(CURRENT_TERM_ORDER_PARAMS).fill(todayYmd)) as RawRow | undefined;
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

  assignments(courseId: string, filter: AssignmentStatusFilter, termId?: string): Assignment[] {
    let from = 'assignments a';
    let where = 'a.course_id = ?';
    const params: SQLInputValue[] = [courseId];
    if (termId !== undefined) {
      from += ' JOIN assignment_terms at ON at.assignment_id = a.id';
      where += ' AND at.term_id = ?';
      params.push(termId);
    }
    if (filter === 'missing') {
      where += ` AND a.status IN (${ACTIONABLE_STATUSES.map((s) => `'${s}'`).join(',')}) AND a.stale = 0`;
    } else if (filter === 'upcoming') {
      where += ` AND a.status = 'not_due' AND a.stale = 0`;
    } else if (filter === 'scored') {
      where += ` AND a.status = 'scored' AND a.stale = 0`;
    }
    // Newest first, matching ParentVUE's own assignment list: what a parent
    // wants to see on opening a course is what was just graded, not September.
    // Undated rows sort last, where they can't push recent work off the top.
    const assignments = (this.db
      .prepare(`SELECT a.* FROM ${from} WHERE ${where} ORDER BY a.due_date IS NULL, a.due_date DESC, a.title`)
      .all(...params) as RawRow[]).map(toAssignment);
    if (assignments.length === 0) return assignments;
    const ids = assignments.map((assignment) => assignment.id);
    const history = this.db.prepare(`
      WITH changed AS (
        SELECT assignment_id FROM assignment_scores
        WHERE assignment_id IN (${ids.map(() => '?').join(',')})
        GROUP BY assignment_id HAVING COUNT(*) > 1
      )
      SELECT s.assignment_id, s.observed_at, s.score, s.score_raw, s.score_letter, s.points_possible
      FROM assignment_scores s
      JOIN changed ON changed.assignment_id = s.assignment_id
      ORDER BY s.observed_at, s.id
    `).all(...ids) as RawRow[];
    const byId = new Map<string, ScorePoint[]>();
    for (const row of history) {
      const id = String(row['assignment_id']);
      const points = byId.get(id) ?? [];
      points.push({
        observedAt: String(row['observed_at']),
        score: num(row['score']),
        scoreRaw: str(row['score_raw']),
        scoreLetter: str(row['score_letter']),
        pointsPossible: num(row['points_possible']),
      });
      byId.set(id, points);
    }
    for (const assignment of assignments) {
      const points = byId.get(assignment.id);
      if (points) assignment.history = points;
    }
    return assignments;
  }

  whatsNew(studentId: string): WhatsNew {
    const eventsCte = `
      WITH cutoff AS (
        SELECT MIN(a.first_seen_at) AS time
        FROM assignments a JOIN courses c ON c.id = a.course_id
        WHERE c.student_id = ?
      ), eligible AS (
        SELECT a.* FROM assignments a JOIN courses c ON c.id = a.course_id
        WHERE c.student_id = ? AND a.stale = 0
      ), events AS (
        SELECT a.id AS assignment_id, a.first_seen_at AS time, 'new_assignment' AS kind
        FROM eligible a, cutoff WHERE a.first_seen_at > cutoff.time
        UNION ALL
        SELECT a.id, a.missing_at, 'now_missing'
        FROM eligible a, cutoff WHERE a.missing_at > cutoff.time
          AND a.missing_at <> a.first_seen_at
        UNION ALL
        SELECT a.id, a.scored_at, 'score'
        FROM eligible a, cutoff WHERE a.scored_at > cutoff.time
          AND a.scored_at <> a.first_seen_at
      )`;
    const anchor = this.db.prepare(`
      ${eventsCte}
      SELECT MAX(time) AS at FROM events
    `).get(studentId, studentId) as RawRow;
    const at = str(anchor['at']);
    if (!at) return { at: null, since: null, items: [] };
    const since = new Date(Date.parse(at) - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      ${eventsCte}, window_events AS (
        SELECT assignment_id, MAX(time) AS event_time,
          MAX(kind = 'new_assignment') AS arrived,
          MAX(kind = 'now_missing') AS became_missing
        FROM events WHERE time > ? GROUP BY assignment_id
      )
      SELECT a.*, c.title AS course_title,
        (SELECT COUNT(*) FROM assignment_scores s
         WHERE s.assignment_id = a.id
           AND (s.score IS NOT NULL OR TRIM(COALESCE(s.score_raw, '')) <> '')) AS score_count,
        e.event_time, e.arrived, e.became_missing
      FROM window_events e
      JOIN assignments a ON a.id = e.assignment_id
      JOIN courses c ON c.id = a.course_id
      ORDER BY event_time DESC, c.title, a.title
    `).all(studentId, studentId, since) as RawRow[];
    return {
      at,
      since,
      // Newly missing work first, then newest event first: the one kind of news that
      // asks a parent to act leads on every surface, not just the dashboard panel.
      // Array.prototype.sort is stable, so the SQL order holds within each group.
      items: rows.map((row) => ({
        kind: Number(row['arrived']) === 1
          ? 'new_assignment' as const
          : Number(row['became_missing']) === 1 ? 'now_missing' as const
          : Number(row['score_count']) >= 2 ? 'rescored' as const : 'new_score' as const,
        assignment: toAssignment(row),
        courseId: String(row['course_id']),
        courseTitle: String(row['course_title']),
      })).sort((a, b) => Number(b.kind === 'now_missing') - Number(a.kind === 'now_missing')),
    };
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
         JOIN assignment_terms at ON at.assignment_id = a.id
         JOIN terms t ON t.id = at.term_id
         JOIN courses c ON c.id = a.course_id
         JOIN course_marks cm ON cm.course_id = c.id AND cm.term_id = t.id
         JOIN students s ON s.id = c.student_id
         WHERE a.status IN (${actionable}) AND a.stale = 0 AND c.stale = 0 AND cm.stale = 0 ${studentFilter}
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
    const { course } = this.resolveCourse(courseId);
    const mark = this.db
      .prepare('SELECT id FROM course_marks WHERE course_id = ? AND term_id = ?')
      .get(courseId, course.termId) as RawRow | undefined;
    if (!mark) throw new GradebookError('not_found', 'Course mark is missing.');
    return (
      this.db
        .prepare('SELECT observed_at, grade_letter, grade_score FROM grade_history WHERE mark_id = ? ORDER BY observed_at')
        .all(String(mark['id'])) as RawRow[]
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

  upsertCourse(
    input: UpsertCourseInput,
    now: string,
  ): { id: string; created: boolean } {
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT id FROM courses WHERE student_id = ? AND school_year = ? AND title = ?')
        .get(input.studentId, input.schoolYear, input.title) as RawRow | undefined;
      if (existing) {
        const id = String(existing['id']);
        this.db
          .prepare(
            'UPDATE courses SET teacher = ?, room = ?, period = ?, last_synced_at = ? WHERE id = ?',
          )
          .run(input.teacher ?? null, input.room ?? null, input.period ?? null, now, id);
        return { id, created: false };
      }
      const id = newId('crs');
      this.db
        .prepare(
          'INSERT INTO courses (id, student_id, school_year, title, teacher, room, period, last_synced_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.studentId,
          input.schoolYear,
          input.title,
          input.teacher ?? null,
          input.room ?? null,
          input.period ?? null,
          now,
        );
      return { id, created: true };
    });
  }

  /** Return a grade change on first observation and whenever a term's mark changes. */
  upsertCourseMark(
    input: UpsertCourseMarkInput,
    now: string,
  ): { id: string; gradeChanged: { before: { letter: string | null; score: number | null }; after: { letter: string | null; score: number | null } } | null } {
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT * FROM course_marks WHERE course_id = ? AND term_id = ?')
        .get(input.courseId, input.termId) as RawRow | undefined;
      const letter = input.gradeLetter ?? null;
      const score = input.gradeScore ?? null;
      if (existing) {
        const id = String(existing['id']);
        const before = { letter: str(existing['grade_letter']), score: num(existing['grade_score']) };
        const changed = before.letter !== letter || before.score !== score;
        const everObserved = Number(
          (this.db.prepare('SELECT COUNT(*) AS n FROM grade_history WHERE mark_id = ?').get(id) as RawRow)['n'] ?? 0,
        );
        this.db
          .prepare(
            'UPDATE course_marks SET grade_letter = ?, grade_score = ?, last_synced_at = ?, stale = 0 WHERE id = ?',
          )
          .run(letter, score, now, id);
        return {
          id,
          gradeChanged: changed || everObserved === 0 ? { before, after: { letter, score } } : null,
        };
      }
      const id = newId('mrk');
      this.db
        .prepare(
          'INSERT INTO course_marks (id, course_id, term_id, grade_letter, grade_score, last_synced_at) VALUES (?,?,?,?,?,?)',
        )
        .run(id, input.courseId, input.termId, letter, score, now);
      return { id, gradeChanged: { before: { letter: null, score: null }, after: { letter, score } } };
    });
  }

  appendGradeHistory(markId: string, observedAt: string, letter: string | null, score: number | null): void {
    this.db
      .prepare('INSERT INTO grade_history (mark_id, observed_at, grade_letter, grade_score) VALUES (?,?,?,?)')
      .run(markId, observedAt, letter, score);
  }

  upsertAssignment(
    input: UpsertAssignmentInput,
    now: string,
  ): { id: string; created: boolean; becameActionable: boolean; scoreEvent: ScoreEvent | null } {
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT * FROM assignments WHERE course_id = ? AND ext_key = ?')
        .get(input.courseId, input.extKey) as RawRow | undefined;
      if (existing) {
        const id = String(existing['id']);
        const before = scoreKey(num(existing['score']), str(existing['score_raw']));
        const after = scoreKey(input.score ?? null, input.scoreRaw ?? null);
        const scoreEvent: ScoreEvent | null = before === after ? null : after === null ? 'cleared' : before === null ? 'new_score' : 'rescored';
        const wasActionable = (ACTIONABLE_STATUSES as string[]).includes(String(existing['status']));
        const isActionable = (ACTIONABLE_STATUSES as string[]).includes(input.status);
        this.db
          .prepare(
            `UPDATE assignments SET title = ?, category = ?, due_date = ?, points_possible = ?,
             score = ?, score_raw = ?, score_letter = ?, status = ?, notes = ?,
             last_seen_at = ?, scored_at = ?, missing_at = ?, stale = 0 WHERE id = ?`,
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
            scoreEvent ? (after === null ? null : now) : str(existing['scored_at']),
            isActionable ? (wasActionable ? str(existing['missing_at']) : now) : null,
            id,
          );
        if (scoreEvent) this.appendAssignmentScore(id, input, after === null, now);
        return { id, created: false, becameActionable: !wasActionable && isActionable, scoreEvent };
      }
      const id = newId('asn');
      this.db
        .prepare(
          `INSERT INTO assignments (id, course_id, ext_key, title, category, due_date, points_possible,
           score, score_raw, score_letter, status, notes, first_seen_at, last_seen_at, scored_at, missing_at, stale)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
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
          scoreKey(input.score ?? null, input.scoreRaw ?? null) === null ? null : now,
          (ACTIONABLE_STATUSES as string[]).includes(input.status) ? now : null,
        );
      const scoreEvent = scoreKey(input.score ?? null, input.scoreRaw ?? null) === null ? null : 'new_score';
      if (scoreEvent) this.appendAssignmentScore(id, input, false, now);
      return {
        id,
        created: true,
        becameActionable: (ACTIONABLE_STATUSES as string[]).includes(input.status),
        scoreEvent,
      };
    });
  }

  private appendAssignmentScore(id: string, input: UpsertAssignmentInput, cleared: boolean, now: string): void {
    this.db.prepare(`
      INSERT INTO assignment_scores
        (assignment_id, observed_at, score, score_raw, score_letter, points_possible)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id, now, cleared ? null : input.score ?? null,
      cleared ? null : input.scoreRaw ?? null,
      cleared ? null : input.scoreLetter ?? null,
      cleared ? null : input.pointsPossible ?? null,
    );
  }

  replaceTermMemberships(termId: string, studentId: string, seenAssignmentIds: ReadonlySet<string>): void {
    return withTransaction(this.db, () => {
      const seen = [...seenAssignmentIds];
      const placeholders = seen.map(() => '?').join(',');
      const notSeen = seen.length > 0 ? `AND at.assignment_id NOT IN (${placeholders})` : '';
      this.db
        .prepare(
          `DELETE FROM assignment_terms AS at
           WHERE at.term_id = ? ${notSeen}
             AND at.assignment_id IN (
               SELECT a.id FROM assignments a
               JOIN courses c ON c.id = a.course_id
               WHERE c.student_id = ?
             )`,
        )
        .run(termId, ...seen, studentId);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO assignment_terms (assignment_id, term_id) VALUES (?, ?)',
      );
      for (const assignmentId of seen) insert.run(assignmentId, termId);
    });
  }

  markStaleCourseMarks(termId: string, seenCourseIds: ReadonlySet<string>): void {
    const seen = [...seenCourseIds];
    const placeholders = seen.map(() => '?').join(',');
    const notSeen = seen.length > 0 ? `AND course_id NOT IN (${placeholders})` : '';
    this.db
      .prepare(`UPDATE course_marks SET stale = 1, missing_count = 0 WHERE term_id = ? ${notSeen}`)
      .run(termId, ...seen);
  }

  /** Derive aggregate staleness after all complete-period memberships are replaced. */
  sweepStale(studentId: string): number {
    return withTransaction(this.db, () => {
      const newlyStale = this.db.prepare(`
        UPDATE assignments SET stale = 1
        WHERE course_id IN (SELECT id FROM courses WHERE student_id = ?)
          AND stale = 0
          AND NOT EXISTS (
            SELECT 1 FROM assignment_terms at WHERE at.assignment_id = assignments.id
          )
      `).run(studentId);
      this.db.prepare(`
        UPDATE assignments SET stale = 0
        WHERE course_id IN (SELECT id FROM courses WHERE student_id = ?)
          AND stale = 1
          AND EXISTS (
            SELECT 1 FROM assignment_terms at WHERE at.assignment_id = assignments.id
          )
      `).run(studentId);
      this.db.prepare(`
        UPDATE courses
        SET stale = CASE WHEN EXISTS (
          SELECT 1 FROM course_marks cm WHERE cm.course_id = courses.id AND cm.stale = 0
        ) THEN 0 ELSE 1 END
        WHERE student_id = ?
      `).run(studentId);
      return Number(newlyStale.changes);
    });
  }

  recomputeMissingCounts(studentId: string): void {
    this.db.prepare(`
      UPDATE course_marks
      SET missing_count = (
        SELECT COUNT(*)
        FROM assignments a
        JOIN assignment_terms at ON at.assignment_id = a.id AND at.term_id = course_marks.term_id
        WHERE a.course_id = course_marks.course_id
          AND a.stale = 0
          AND a.status IN (${ACTIONABLE_STATUSES.map((s) => `'${s}'`).join(',')})
      )
      WHERE course_id IN (SELECT id FROM courses WHERE student_id = ?)
    `).run(studentId);
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
