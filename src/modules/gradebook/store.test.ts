import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase } from '../../storage/sqlite.js';
import { describeScoreTrail, renderAssignments, renderOverview, scoreKey } from './logic.js';
import { MIGRATIONS } from './migrations.js';
import { GradebookStore, fallbackExtKey } from './store.js';

function freshStore(): GradebookStore {
  const db = openDatabase(':memory:');
  migrate(db, MIGRATIONS);
  return new GradebookStore(db);
}

const NOW = '2026-09-13T12:00:00.000Z';
const YEAR = '2026-2027';

describe('gradebook migration v5', () => {
  it('backfills numeric and code scores at first sight, leaving unscored work alone', () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 4));
    db.exec(`
      INSERT INTO students VALUES ('stu_a', 'pv_a', 'Aiden', 'Odle', NULL, '2026-09-01', '2026-09-01');
      INSERT INTO courses (id, student_id, school_year, title) VALUES ('crs_a', 'stu_a', '2026-2027', 'Science');
      INSERT INTO assignments
        (id, course_id, ext_key, title, score, score_raw, score_letter, status, first_seen_at, last_seen_at)
      VALUES
        ('asn_num', 'crs_a', 'num', 'Numeric', 3.5, '3.50', NULL, 'scored', '2026-09-01', '2026-09-20'),
        ('asn_code', 'crs_a', 'code', 'Code', NULL, ' A ', 'A', 'scored', '2026-09-02', '2026-09-20'),
        ('asn_none', 'crs_a', 'none', 'None', NULL, '  ', NULL, 'not_due', '2026-09-03', '2026-09-20');
    `);
    migrate(db, MIGRATIONS);
    expect(db.prepare('SELECT id, scored_at FROM assignments ORDER BY id').all()).toEqual([
      { id: 'asn_code', scored_at: '2026-09-02' },
      { id: 'asn_none', scored_at: null },
      { id: 'asn_num', scored_at: '2026-09-01' },
    ]);
    expect(db.prepare('SELECT assignment_id, observed_at, score, score_raw FROM assignment_scores ORDER BY assignment_id').all()).toEqual([
      { assignment_id: 'asn_code', observed_at: '2026-09-02', score: null, score_raw: ' A ' },
      { assignment_id: 'asn_num', observed_at: '2026-09-01', score: 3.5, score_raw: '3.50' },
    ]);
    db.close();
  });
});

describe('score helpers', () => {
  it('compares numeric values and trimmed, case-sensitive code marks', () => {
    expect(scoreKey(3.5, '3.5')).toBe(scoreKey(3.5, '3.50'));
    expect(scoreKey(null, 'A')).toBe(scoreKey(null, ' A '));
    expect(scoreKey(null, 'A')).not.toBe(scoreKey(null, 'Y'));
    expect(scoreKey(null, '  ')).toBeNull();
  });

  it('describes numeric, code and cleared trail points', () => {
    expect(describeScoreTrail([
      { observedAt: NOW, score: 2.5, scoreRaw: '2.5', scoreLetter: null, pointsPossible: 4 },
      { observedAt: NOW, score: 3.5, scoreRaw: '3.5', scoreLetter: null, pointsPossible: 4 },
      { observedAt: NOW, score: null, scoreRaw: 'A', scoreLetter: 'A', pointsPossible: null },
      { observedAt: NOW, score: null, scoreRaw: null, scoreLetter: null, pointsPossible: null },
    ])).toBe('2.5/4 → 3.5/4 → A → —');
  });
});

describe('gradebook migration v4', () => {
  it('merges v3 course and assignment duplicates without breaking foreign keys', () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 3));
    db.exec(`
      INSERT INTO students VALUES
        ('stu_a', 'pv_a', 'Aiden', 'Odle', '06', '2026-09-01', '2026-09-20'),
        ('stu_b', 'pv_b', 'Andrew', 'Medina', '03', '2026-09-01', '2026-09-20');
      INSERT INTO terms VALUES
        ('trm_q1', 'stu_a', '2026-2027', 'Quarter 1', 0, '2026-09-02', '2026-11-06', '2026-09-20'),
        ('trm_s1', 'stu_a', '2026-2027', 'Semester 1 Final', 1, '2026-11-09', '2027-01-28', '2026-09-20'),
        ('trm_q3', 'stu_a', '2026-2027', 'Quarter 3', 2, '2027-02-01', '2027-04-09', '2026-09-20'),
        ('trm_s2', 'stu_a', '2026-2027', 'Semester 2 Final', 3, '2027-04-19', '2027-06-23', '2026-09-20');
      INSERT INTO courses
        (id, term_id, title, teacher, room, period, grade_letter, grade_score, missing_count, last_synced_at, stale)
      VALUES
        ('crs_sci_q1', 'trm_q1', 'Science', 'Old Teacher', '1', '1', 'B', 3.0, 1, '2026-09-10', 0),
        ('crs_sci_s1', 'trm_s1', 'Science', 'Teacher', '2', '2', 'A', 3.7, 0, '2026-09-20', 0),
        ('crs_sci_q3', 'trm_q3', 'Science', 'Teacher', '2', '2', NULL, NULL, 0, '2026-09-20', 0),
        ('crs_sci_s2', 'trm_s2', 'Science', 'Newest Teacher', '3', '3', NULL, NULL, 0, '2026-09-21', 1),
        ('crs_pe_q1', 'trm_q1', 'PE 6th', 'Coach', 'Gym', '5', 'A', 4.0, 0, '2026-09-10', 0),
        ('crs_pe_s1', 'trm_s1', 'PE 6th', 'Coach', 'Gym', '5', 'A', 4.0, 0, '2026-09-20', 0);
      INSERT INTO assignments
        (id, course_id, ext_key, title, category, due_date, points_possible, score, score_raw,
         score_letter, status, notes, first_seen_at, last_seen_at, stale)
      VALUES
        ('asn_lab_q1', 'crs_sci_q1', 'lab', 'Lab', 'Lab', '2026-09-10', 10, 8, '8', NULL, 'scored', NULL, '2026-09-01', '2026-09-10', 0),
        ('asn_lab_s1', 'crs_sci_s1', 'lab', 'Lab', 'Lab', '2026-09-10', 10, 8, '8', NULL, 'scored', NULL, '2026-09-05', '2026-09-20', 0),
        ('asn_quiz_q1', 'crs_sci_q1', 'quiz', 'Quiz', NULL, '2026-09-12', 10, NULL, NULL, NULL, 'missing', NULL, '2026-09-03', '2026-09-10', 1),
        ('asn_quiz_s1', 'crs_sci_s1', 'quiz', 'Quiz', NULL, '2026-09-12', 10, NULL, NULL, NULL, 'missing', NULL, '2026-09-02', '2026-09-20', 0),
        ('asn_project_q3', 'crs_sci_q3', 'project', 'Project', NULL, '2027-03-01', 20, NULL, NULL, NULL, 'not_due', NULL, '2027-02-01', '2027-02-01', 0),
        ('asn_run_q1', 'crs_pe_q1', 'run', 'Mile Run', NULL, '2026-10-01', 10, 10, '10', NULL, 'scored', NULL, '2026-09-15', '2026-10-01', 0),
        ('asn_run_s1', 'crs_pe_s1', 'run', 'Mile Run', NULL, '2026-10-01', 10, 10, '10', NULL, 'scored', NULL, '2026-09-16', '2026-10-02', 1);
      INSERT INTO grade_history (id, course_id, observed_at, grade_letter, grade_score) VALUES
        (1, 'crs_sci_q1', '2026-09-10', 'B', 3.0),
        (2, 'crs_sci_s1', '2026-09-20', 'A', 3.7),
        (3, 'crs_pe_s1', '2026-09-20', 'A', 4.0);
    `);

    migrate(db, MIGRATIONS);

    expect((db.prepare('SELECT COUNT(*) AS n FROM courses').get() as { n: number }).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM course_marks').get() as { n: number }).n).toBe(6);
    expect((db.prepare('SELECT COUNT(*) AS n FROM assignments').get() as { n: number }).n).toBe(4);
    expect(db.prepare('SELECT id, teacher, room, period, stale FROM courses ORDER BY title').all()).toEqual([
      { id: 'crs_pe_q1', teacher: 'Coach', room: 'Gym', period: '5', stale: 0 },
      { id: 'crs_sci_q1', teacher: 'Newest Teacher', room: '3', period: '3', stale: 0 },
    ]);
    expect(db.prepare('SELECT id, first_seen_at, last_seen_at, stale FROM assignments ORDER BY ext_key').all()).toEqual([
      { id: 'asn_lab_q1', first_seen_at: '2026-09-01', last_seen_at: '2026-09-20', stale: 0 },
      { id: 'asn_project_q3', first_seen_at: '2027-02-01', last_seen_at: '2027-02-01', stale: 0 },
      { id: 'asn_quiz_s1', first_seen_at: '2026-09-02', last_seen_at: '2026-09-20', stale: 0 },
      { id: 'asn_run_q1', first_seen_at: '2026-09-15', last_seen_at: '2026-10-02', stale: 0 },
    ]);
    expect(db.prepare('SELECT assignment_id, term_id FROM assignment_terms ORDER BY assignment_id, term_id').all()).toEqual([
      { assignment_id: 'asn_lab_q1', term_id: 'trm_q1' },
      { assignment_id: 'asn_lab_q1', term_id: 'trm_s1' },
      { assignment_id: 'asn_project_q3', term_id: 'trm_q3' },
      { assignment_id: 'asn_quiz_s1', term_id: 'trm_s1' },
      { assignment_id: 'asn_run_q1', term_id: 'trm_q1' },
    ]);
    expect(db.prepare(`
      SELECT gh.id, cm.term_id, c.id AS course_id
      FROM grade_history gh
      JOIN course_marks cm ON cm.id = gh.mark_id
      JOIN courses c ON c.id = cm.course_id
      ORDER BY gh.id
    `).all()).toEqual([
      { id: 1, term_id: 'trm_q1', course_id: 'crs_sci_q1' },
      { id: 2, term_id: 'trm_s1', course_id: 'crs_sci_q1' },
      { id: 3, term_id: 'trm_s1', course_id: 'crs_pe_q1' },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

describe('GradebookStore', () => {
  let store: GradebookStore;
  beforeEach(() => {
    store = freshStore();
  });

  function student(): string {
    return store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW).id;
  }

  function term(studentId: string, name: string, index: number, start?: string, end?: string): string {
    return store.upsertTerm({ studentId, schoolYear: YEAR, reportingPeriod: name, periodIndex: index, periodStart: start, periodEnd: end }, NOW).id;
  }

  function course(studentId: string, title = 'Science'): string {
    return store.upsertCourse({ studentId, schoolYear: YEAR, title }, NOW).id;
  }

  it('upserts students and year-long courses idempotently', () => {
    const sid = student();
    const first = store.upsertCourse({ studentId: sid, schoolYear: YEAR, title: 'Science', teacher: 'A' }, NOW);
    const second = store.upsertCourse({ studentId: sid, schoolYear: YEAR, title: 'Science', teacher: 'B' }, NOW);
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(store.counts()).toMatchObject({ students: 1, courses: 1 });
    expect(store.resolveStudent('aiden').id).toBe(sid);
  });

  it('defaults to the period in progress and counts its marks', () => {
    const sid = student();
    const q1 = term(sid, 'Quarter 1', 0, '2026-09-02', '2026-11-06');
    const s1 = term(sid, 'Semester 1 Final', 1, '2026-11-09', '2027-01-28');
    const cid = course(sid);
    store.upsertCourseMark({ courseId: cid, termId: q1, gradeLetter: 'B' }, NOW);
    store.upsertCourseMark({ courseId: cid, termId: s1, gradeLetter: 'A' }, NOW);

    expect(store.latestTerm(sid, '2026-09-13')?.reportingPeriod).toBe('Quarter 1');
    expect(store.terms(sid).map((value) => value.reportingPeriod)).toEqual(['Semester 1 Final', 'Quarter 1']);
    expect(store.resolveTerm(sid, YEAR, 'quarter 1').courseCount).toBe(1);
    expect(store.courses(q1)[0]).toMatchObject({ id: cid, termId: q1, gradeLetter: 'B' });
    expect(store.courses(s1)[0]).toMatchObject({ id: cid, termId: s1, gradeLetter: 'A' });
  });

  it('tracks grade history separately for each mark and resolves the current one', () => {
    const sid = student();
    const q1 = term(sid, 'Quarter 1', 0, '2026-09-02', '2026-11-06');
    const s1 = term(sid, 'Semester 1 Final', 1, '2026-11-09', '2027-01-28');
    const cid = course(sid);
    const q1Mark = store.upsertCourseMark({ courseId: cid, termId: q1, gradeLetter: 'B', gradeScore: 3 }, NOW);
    store.appendGradeHistory(q1Mark.id, NOW, 'B', 3);
    const same = store.upsertCourseMark({ courseId: cid, termId: q1, gradeLetter: 'B', gradeScore: 3 }, NOW);
    expect(same.gradeChanged).toBeNull();
    const s1Mark = store.upsertCourseMark({ courseId: cid, termId: s1, gradeLetter: 'A', gradeScore: 4 }, NOW);
    store.appendGradeHistory(s1Mark.id, NOW, 'A', 4);

    expect(store.resolveCourse(cid).course).toMatchObject({ termId: q1, gradeLetter: 'B' });
    expect(store.trend(cid).map((point) => point.gradeLetter)).toEqual(['B']);
  });

  it('uses assignment memberships for period reads and missing counts', () => {
    const sid = student();
    const q1 = term(sid, 'Quarter 1', 0);
    const s1 = term(sid, 'Semester 1 Final', 1);
    const cid = course(sid);
    store.upsertCourseMark({ courseId: cid, termId: q1 }, NOW);
    store.upsertCourseMark({ courseId: cid, termId: s1 }, NOW);
    const both = store.upsertAssignment({ courseId: cid, extKey: 'both', title: 'Both', status: 'scored' }, NOW);
    const q1Only = store.upsertAssignment({ courseId: cid, extKey: 'q1', title: 'Q1 Missing', status: 'missing' }, NOW);
    const s1Only = store.upsertAssignment({ courseId: cid, extKey: 's1', title: 'S1 Work', status: 'not_due' }, NOW);
    store.replaceTermMemberships(q1, sid, new Set([both.id, q1Only.id]));
    store.replaceTermMemberships(s1, sid, new Set([both.id, s1Only.id]));
    store.sweepStale(sid);
    store.recomputeMissingCounts(sid);

    expect(store.assignments(cid, 'all', q1).map((value) => value.title)).toEqual(['Both', 'Q1 Missing']);
    expect(store.assignments(cid, 'all', s1).map((value) => value.title)).toEqual(['Both', 'S1 Work']);
    expect(store.assignments(cid, 'all')).toHaveLength(3);
    expect(store.missing(sid, q1).map((value) => value.title)).toEqual(['Q1 Missing']);
    expect(store.missing(sid, s1)).toEqual([]);
    expect(store.courses(q1)[0]?.missingCount).toBe(1);
    expect(store.courses(s1)[0]?.missingCount).toBe(0);
  });

  it('derives assignment and course staleness from memberships and live marks', () => {
    const sid = student();
    const q1 = term(sid, 'Quarter 1', 0);
    const cid = course(sid);
    store.upsertCourseMark({ courseId: cid, termId: q1 }, NOW);
    const assignment = store.upsertAssignment({ courseId: cid, extKey: 'a', title: 'Lab', status: 'missing' }, NOW);
    store.replaceTermMemberships(q1, sid, new Set([assignment.id]));
    store.sweepStale(sid);
    expect(store.assignments(cid, 'all')[0]?.stale).toBe(false);

    store.replaceTermMemberships(q1, sid, new Set());
    store.markStaleCourseMarks(q1, new Set());
    expect(store.sweepStale(sid)).toBe(1);
    expect(store.assignments(cid, 'all')[0]?.stale).toBe(true);
    expect(store.courses(q1)).toEqual([]);
    expect(() => store.resolveCourse(cid)).toThrow(/No course matches/);
  });

  it('sorts whole-year assignments and keeps collected work out of filters', () => {
    const sid = student();
    const cid = course(sid);
    store.upsertAssignment({ courseId: cid, extKey: 'old', title: 'Old', status: 'collected', dueDate: '2026-09-04' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'new', title: 'New', status: 'not_due', dueDate: '2026-11-06' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'none', title: 'No date', status: 'not_due' }, NOW);
    expect(store.assignments(cid, 'all').map((value) => value.title)).toEqual(['New', 'Old', 'No date']);
    expect(store.assignments(cid, 'upcoming').map((value) => value.title)).toEqual(['New', 'No date']);
    expect(store.assignments(cid, 'missing')).toEqual([]);
  });

  it('records score transitions and reads changed history in one lookup', () => {
    const cid = course(student());
    const input = { courseId: cid, extKey: 'a', title: 'Quiz', status: 'scored' as const };
    const first = store.upsertAssignment({ ...input, score: null, scoreRaw: null }, NOW);
    expect(first.scoreEvent).toBeNull();
    const sameEmpty = store.upsertAssignment({ ...input, scoreRaw: '  ' }, NOW);
    expect(sameEmpty.scoreEvent).toBeNull();
    const scored = store.upsertAssignment({ ...input, score: 2.5, scoreRaw: '2.5', pointsPossible: 4 }, '2026-09-14');
    expect(scored.scoreEvent).toBe('new_score');
    expect(store.assignments(cid, 'all')[0]).toMatchObject({ scoredAt: '2026-09-14' });
    expect(store.assignments(cid, 'all')[0]).not.toHaveProperty('history');
    expect(store.upsertAssignment({ ...input, score: 2.5, scoreRaw: '2.50', pointsPossible: 5 }, '2026-09-15').scoreEvent).toBeNull();
    expect(store.upsertAssignment({ ...input, score: 3.5, scoreRaw: '3.5', pointsPossible: 4 }, '2026-09-16').scoreEvent).toBe('rescored');
    expect(store.upsertAssignment({ ...input, score: null, scoreRaw: null }, '2026-09-17').scoreEvent).toBe('cleared');
    expect(store.assignments(cid, 'all')[0]?.scoredAt).toBeNull();
    const code = store.upsertAssignment({ ...input, scoreRaw: 'A', scoreLetter: 'A' }, '2026-09-18');
    expect(code.scoreEvent).toBe('new_score');
    expect(store.upsertAssignment({ ...input, scoreRaw: ' A ', scoreLetter: 'A' }, '2026-09-19').scoreEvent).toBeNull();
    expect(store.upsertAssignment({ ...input, scoreRaw: 'Y', scoreLetter: 'Y' }, '2026-09-20').scoreEvent).toBe('rescored');
    const other = store.upsertAssignment({ ...input, extKey: 'b', title: 'Lab', score: 1, scoreRaw: '1' }, NOW);
    expect(other).toMatchObject({ created: true, scoreEvent: 'new_score' });
    const prepare = vi.spyOn((store as unknown as { db: { prepare: (sql: string) => unknown } }).db, 'prepare');
    const assignments = store.assignments(cid, 'all');
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('FROM assignment_scores'))).toHaveLength(1);
    prepare.mockRestore();
    expect(assignments.find((a) => a.id === other.id)).toMatchObject({ scoredAt: NOW, firstSeenAt: NOW });
    expect(assignments.find((a) => a.id === other.id)).not.toHaveProperty('history');
    const changed = assignments.find((a) => a.id === first.id)!;
    expect(changed.history?.map((point) => point.scoreRaw)).toEqual(['2.5', '3.5', null, 'A', 'Y']);
    expect(changed.history?.[2]).toMatchObject({ score: null, scoreRaw: null, scoreLetter: null, pointsPossible: null });
    expect(renderAssignments({ title: 'Science' } as Parameters<typeof renderAssignments>[0], [changed], 'all')).toContain('was 2.5/4 → 3.5/4 → — → A');
  });

  it('records sync runs with their trigger and finish time', () => {
    const id = store.beginSyncRun(NOW, 'scheduled');
    store.finishSyncRun(id, 'ok', { students: [] }, new Date('2026-09-13T12:00:05.000Z'));
    expect(store.lastSyncRun()).toMatchObject({ id, status: 'ok', trigger: 'scheduled' });
    expect(store.lastSyncRunBy('scheduled')?.finishedAt).toBe('2026-09-13T12:00:05.000Z');
  });

  it('throws not_found for unknown refs', () => {
    expect(() => store.resolveStudent('nobody')).toThrow(/No student matches/);
    expect(() => store.resolveCourse('crs_nope')).toThrow(/No course matches/);
  });
});

describe('fallbackExtKey', () => {
  it('is stable and distinct', () => {
    const a = fallbackExtKey('Math', 'HW 1', '2026-09-10');
    expect(fallbackExtKey('Math', 'HW 1', '2026-09-10')).toBe(a);
    expect(fallbackExtKey('Math', 'HW 2', '2026-09-10')).not.toBe(a);
    expect(a.startsWith('fb:')).toBe(true);
  });
});

describe('sticky whatsNew', () => {
  let store: GradebookStore;
  beforeEach(() => { store = freshStore(); });

  function setup(name = 'Aiden', studentAt = '2026-09-01T00:00:00.000Z') {
    const studentId = store.upsertStudent({ parentvueId: name, name, school: 'Odle' }, studentAt).id;
    const courseId = store.upsertCourse({ studentId, schoolYear: YEAR, title: 'Science' }, studentAt).id;
    const add = (key: string, at: string, score?: number) => store.upsertAssignment({
      courseId, extKey: key, title: key, status: 'scored', score, scoreRaw: score === undefined ? null : String(score),
    }, at);
    return { studentId, courseId, add };
  }

  it('does not call the first sync new when student and gradebook arrive together', () => {
    const first = '2026-09-20T00:00:00.000Z';
    const { studentId, add } = setup('Aiden', first);
    add('First Lab', first, 4);
    expect(store.whatsNew(studentId)).toEqual({ at: null, since: null, items: [] });
  });

  it('uses the first gradebook assignment as cutoff and keeps two nearby arrivals through empty syncs', () => {
    const { studentId, add } = setup();
    add('bootstrap', '2026-09-20T12:00:00.000Z');
    expect(store.whatsNew(studentId)).toEqual({ at: null, since: null, items: [] });
    add('first', '2026-09-21T12:00:00.000Z');
    add('second', '2026-09-21T12:05:00.000Z');
    const before = store.whatsNew(studentId);
    expect(before.at).toBe('2026-09-21T12:05:00.000Z');
    expect(before.since).toBe('2026-09-20T12:05:00.000Z');
    expect(before.items.map((item) => [item.assignment.title, item.kind])).toEqual([
      ['second', 'new_assignment'], ['first', 'new_assignment'],
    ]);
    add('first', '2026-09-21T13:00:00.000Z');
    const after = store.whatsNew(studentId);
    expect(after.at).toBe(before.at);
    expect(after.since).toBe(before.since);
    expect(after.items.map((item) => [item.assignment.id, item.kind]))
      .toEqual(before.items.map((item) => [item.assignment.id, item.kind]));
  });

  it('uses an anchored 24-hour window independently for each student', () => {
    const a = setup('Aiden');
    const b = setup('Bella');
    a.add('bootstrap', '2026-09-20T00:00:00.000Z');
    b.add('bootstrap', '2026-09-20T00:00:00.000Z');
    a.add('old', '2026-09-21T00:00:00.000Z');
    b.add('bella-new', '2026-09-21T00:00:00.000Z');
    a.add('latest', '2026-09-22T01:00:00.000Z');
    expect(store.whatsNew(a.studentId).items.map((item) => item.assignment.title)).toEqual(['latest']);
    expect(store.whatsNew(b.studentId).items.map((item) => item.assignment.title)).toEqual(['bella-new']);
  });

  it('keeps one new-assignment item when a score arrives later and orders by the later event', () => {
    const { studentId, add } = setup();
    add('bootstrap', '2026-09-20T00:00:00.000Z');
    add('arrived', '2026-09-21T10:00:00.000Z');
    add('other', '2026-09-21T11:00:00.000Z');
    add('arrived', '2026-09-21T12:00:00.000Z', 4);
    expect(store.whatsNew(studentId).items.map((item) => [item.assignment.title, item.kind])).toEqual([
      ['arrived', 'new_assignment'], ['other', 'new_assignment'],
    ]);
  });

  it('prioritizes new assignments and classifies posted, changed, and cleared scores', () => {
    const { studentId, courseId, add } = setup();
    add('bootstrap', '2026-09-20T00:00:00.000Z');
    add('older-scored', '2026-09-20T00:00:00.000Z', 2);
    add('older-unscored', '2026-09-20T00:00:00.000Z');
    add('to-clear', '2026-09-20T00:00:00.000Z', 1);
    const at = '2026-09-21T00:00:00.000Z';
    add('arrived-scored', at, 3);
    store.upsertAssignment({ courseId, extKey: 'older-scored', title: 'older-scored', status: 'scored', score: 4, scoreRaw: '4' }, at);
    store.upsertAssignment({ courseId, extKey: 'older-unscored', title: 'older-unscored', status: 'scored', scoreRaw: 'A', scoreLetter: 'A' }, at);
    store.upsertAssignment({ courseId, extKey: 'to-clear', title: 'to-clear', status: 'scored' }, at);
    const result = store.whatsNew(studentId);
    expect(result.items.map((item) => [item.assignment.title, item.kind])).toEqual([
      ['arrived-scored', 'new_assignment'],
      ['older-scored', 'rescored'],
      ['older-unscored', 'new_score'],
    ]);
    expect(result.items[0]?.assignment.score).toBe(3);
    expect(result.items[1]?.courseId).toBe(courseId);
    expect(result.items[1]?.courseTitle).toBe('Science');
    const spy = vi.spyOn((store as unknown as { db: { prepare: (sql: string) => unknown } }).db, 'prepare');
    store.whatsNew(studentId);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('excludes stale work and backfilled first-sight scores', () => {
    const { studentId, courseId, add } = setup();
    add('bootstrap', '2026-09-20T00:00:00.000Z');
    const stale = add('stale', '2026-09-21T00:00:00.000Z');
    const backfilled = add('backfilled', '2026-09-21T01:00:00.000Z', 3);
    const db = (store as unknown as { db: ReturnType<typeof openDatabase> }).db;
    db.prepare('UPDATE assignments SET stale = 1 WHERE id = ?').run(stale.id);
    db.prepare('UPDATE assignments SET first_seen_at = ?, scored_at = ? WHERE id = ?')
      .run('2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z', backfilled.id);
    expect(store.whatsNew(studentId)).toEqual({ at: null, since: null, items: [] });
    expect(store.assignments(courseId, 'all').find((item) => item.id === backfilled.id)?.scoredAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('renders the overview section only when there are items', () => {
    const { studentId, add } = setup();
    add('bootstrap', '2026-09-20T00:00:00.000Z');
    const student = store.resolveStudent(studentId);
    const overview = () => renderOverview([{ student, term: null, courses: [], whatsNew: store.whatsNew(studentId) }]);
    expect(overview()).not.toContain("What's new");
    add('Lab', '2026-09-21T00:00:00.000Z');
    expect(overview()).toContain("What's new since 2026-09-20 00:00:00Z");
    const zoned = renderOverview([{ student, term: null, courses: [], whatsNew: store.whatsNew(studentId) }], 'America/Los_Angeles');
    expect(zoned).toContain("What's new since Sep 19, 2026, 5:00 PM");
    expect(overview()).toContain('Lab (Science) · new assignment · —');
  });
});
