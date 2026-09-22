import { beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../storage/sqlite.js';
import { MIGRATIONS } from './migrations.js';
import { GradebookStore, fallbackExtKey } from './store.js';

function freshStore(): GradebookStore {
  const db = openDatabase(':memory:');
  migrate(db, MIGRATIONS);
  return new GradebookStore(db);
}

const NOW = '2026-09-13T12:00:00.000Z';
const YEAR = '2026-2027';

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
