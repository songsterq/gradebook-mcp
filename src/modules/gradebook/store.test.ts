import { describe, expect, it, beforeEach } from 'vitest';
import { migrate, openDatabase } from '../../storage/sqlite.js';
import { MIGRATIONS } from './migrations.js';
import { GradebookStore, fallbackExtKey } from './store.js';

function freshStore(): GradebookStore {
  const db = openDatabase(':memory:');
  migrate(db, MIGRATIONS);
  return new GradebookStore(db);
}

const NOW = '2026-09-13T12:00:00.000Z';

describe('GradebookStore', () => {
  let store: GradebookStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('upserts students idempotently by parentvue_id', () => {
    const first = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden Chien', school: 'Odle' }, NOW);
    const second = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden Chien', school: 'Odle Middle' }, NOW);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.id).toBe(second.id);
    expect(store.resolveStudent('aiden chien').school).toBe('Odle Middle');
    expect(store.resolveStudent(first.id).name).toBe('Aiden Chien');
  });

  it('resolves the latest term and lists terms newest-first', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Quarter 1', periodIndex: 0 }, NOW);
    store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Quarter 2', periodIndex: 1 }, NOW);
    const terms = store.terms(sid);
    expect(terms.map((t) => t.reportingPeriod)).toEqual(['Quarter 2', 'Quarter 1']);
    expect(store.latestTerm(sid)?.reportingPeriod).toBe('Quarter 2');
    expect(store.resolveTerm(sid, '2026-2027', 'quarter 1').reportingPeriod).toBe('Quarter 1');
  });

  it('defaults to the current term instead of the last future term advertised', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const q1 = store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Quarter 1',
      periodIndex: 0,
      periodStart: '2026-09-02',
      periodEnd: '2026-11-06',
    }, NOW);
    const q2 = store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Quarter 2',
      periodIndex: 1,
      periodStart: '2026-11-09',
      periodEnd: '2027-01-29',
    }, NOW);
    const current = store.upsertCourse({ termId: q1.id, title: 'Current Math' }, NOW);
    const future = store.upsertCourse({ termId: q2.id, title: 'Future Math' }, NOW);
    store.upsertAssignment({ courseId: current.id, extKey: 'now', title: 'Current HW', status: 'missing' }, NOW);
    store.upsertAssignment({ courseId: future.id, extKey: 'later', title: 'Future HW', status: 'missing' }, NOW);

    expect(store.latestTerm(sid, '2026-09-13')?.reportingPeriod).toBe('Quarter 1');
    expect(store.missing(sid, undefined, '2026-09-13').map((a) => a.title)).toEqual(['Current HW']);
  });

  it('stays on the term in progress rather than one that has already ended', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Quarter 1',
      periodIndex: 0,
      periodStart: '2026-09-02',
      periodEnd: '2026-11-06',
    }, NOW);
    store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Semester 1 Final',
      periodIndex: 1,
      periodStart: '2026-11-09',
      periodEnd: '2027-01-28',
    }, NOW);
    store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Semester 2 Final',
      periodIndex: 3,
      periodStart: '2027-04-06',
      periodEnd: '2027-06-18',
    }, NOW);

    expect(store.latestTerm(sid, '2026-09-14')?.reportingPeriod).toBe('Quarter 1');
    expect(store.latestTerm(sid, '2026-12-01')?.reportingPeriod).toBe('Semester 1 Final');
    // Between periods (winter break) and after the year ends, the most
    // recently finished term is the best available answer.
    expect(store.latestTerm(sid, '2027-02-15')?.reportingPeriod).toBe('Semester 1 Final');
    expect(store.latestTerm(sid, '2027-08-01')?.reportingPeriod).toBe('Semester 2 Final');
  });

  it('prefers the quarter over an umbrella semester that covers the same day', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Semester 1',
      periodIndex: 4,
      periodStart: '2026-09-02',
      periodEnd: '2027-01-28',
    }, NOW);
    store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Quarter 1',
      periodIndex: 0,
      periodStart: '2026-09-02',
      periodEnd: '2026-11-06',
    }, NOW);

    expect(store.latestTerm(sid, '2026-09-14')?.reportingPeriod).toBe('Quarter 1');
  });

  it('tracks grade history only on change', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const { id: tid } = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0 }, NOW);
    const first = store.upsertCourse({ termId: tid, title: 'Math', gradeLetter: 'B', gradeScore: 3.0 }, NOW);
    expect(first.gradeChanged).not.toBeNull();
    store.appendGradeHistory(first.id, NOW, 'B', 3.0);

    const same = store.upsertCourse({ termId: tid, title: 'Math', gradeLetter: 'B', gradeScore: 3.0 }, NOW);
    expect(same.gradeChanged).toBeNull();

    const changed = store.upsertCourse({ termId: tid, title: 'Math', gradeLetter: 'A', gradeScore: 4.0 }, NOW);
    expect(changed.gradeChanged).toMatchObject({ before: { letter: 'B', score: 3 }, after: { letter: 'A', score: 4 } });
    store.appendGradeHistory(changed.id, '2026-09-14T12:00:00.000Z', 'A', 4.0);

    expect(store.trend(first.id).map((p) => p.gradeLetter)).toEqual(['B', 'A']);
  });

  it('upserts assignments, marks stale ones, and recomputes missing counts', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const { id: tid } = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0 }, NOW);
    const { id: cid } = store.upsertCourse({ termId: tid, title: 'Science' }, NOW);

    store.upsertAssignment({
      courseId: cid, extKey: 'a1', title: 'Lab', status: 'missing', dueDate: '2026-09-10',
    }, NOW);
    store.upsertAssignment({
      courseId: cid, extKey: 'a2', title: 'Quiz', status: 'scored', score: 9, pointsPossible: 10,
    }, NOW);
    expect(store.recomputeMissingCount(cid)).toBe(1);

    // a1 rescored, a2 gone from the snapshot
    const r = store.upsertAssignment({
      courseId: cid, extKey: 'a1', title: 'Lab', status: 'scored', score: 8, pointsPossible: 10, dueDate: '2026-09-10',
    }, NOW);
    expect(r.becameActionable).toBe(false);
    expect(store.markStaleAssignments(cid, new Set(['a1']))).toBe(1);
    expect(store.recomputeMissingCount(cid)).toBe(0);

    const all = store.assignments(cid, 'all');
    expect(all.find((a) => a.extKey === 'a2')?.stale).toBe(true);
    expect(store.assignments(cid, 'missing')).toHaveLength(0);
    expect(store.assignments(cid, 'scored')).toHaveLength(1);
  });

  it('lists assignments newest-due first, undated last', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const { id: tid } = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0 }, NOW);
    const { id: cid } = store.upsertCourse({ termId: tid, title: 'Science' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a1', title: 'Survey', status: 'scored', score: 3.5, dueDate: '2026-09-04' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a2', title: 'Summative', status: 'not_due', dueDate: '2026-11-06' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a3', title: 'Quiz 1', status: 'scored', score: 3.5, dueDate: '2026-09-18' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a4', title: 'No date', status: 'not_due' }, NOW);

    expect(store.assignments(cid, 'all').map((a) => a.title)).toEqual([
      'Summative', 'Quiz 1', 'Survey', 'No date',
    ]);
  });

  it('reports missing work across the latest term only', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const t1 = store.upsertTerm({ studentId: sid, schoolYear: '2025-2026', reportingPeriod: 'Q4', periodIndex: 3 }, NOW);
    const t2 = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0 }, NOW);
    const c1 = store.upsertCourse({ termId: t1.id, title: 'Old Math' }, NOW);
    const c2 = store.upsertCourse({ termId: t2.id, title: 'New Math' }, NOW);
    store.upsertAssignment({ courseId: c1.id, extKey: 'old', title: 'Old HW', status: 'missing' }, NOW);
    store.upsertAssignment({ courseId: c2.id, extKey: 'new', title: 'New HW', status: 'missing', dueDate: '2026-09-12' }, NOW);

    const missing = store.missing(sid);
    expect(missing.map((a) => a.title)).toEqual(['New HW']);
    expect(missing[0]).toMatchObject({ studentName: 'Aiden', courseTitle: 'New Math' });
  });

  it('scopes missing work to one term when asked', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const t1 = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0 }, NOW);
    const t2 = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q2', periodIndex: 1 }, NOW);
    const c1 = store.upsertCourse({ termId: t1.id, title: 'Math' }, NOW);
    const c2 = store.upsertCourse({ termId: t2.id, title: 'Math' }, NOW);
    store.upsertAssignment({ courseId: c1.id, extKey: 'q1', title: 'Q1 HW', status: 'missing' }, NOW);
    store.upsertAssignment({ courseId: c2.id, extKey: 'q2', title: 'Q2 HW', status: 'missing' }, NOW);

    // Default: the latest term, which is what "what's missing now" means.
    expect(store.missing(sid).map((a) => a.title)).toEqual(['Q2 HW']);
    // The dashboard's term picker asks for the term on screen.
    expect(store.missing(sid, t1.id).map((a) => a.title)).toEqual(['Q1 HW']);
    expect(store.missing(undefined, t1.id).map((a) => a.title)).toEqual(['Q1 HW']);
  });

  it('treats collected work as neither upcoming nor missing', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const { id: tid } = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0 }, NOW);
    const { id: cid } = store.upsertCourse({ termId: tid, title: 'Science' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a1', title: 'Handed in', status: 'collected' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a2', title: 'Next week', status: 'not_due' }, NOW);

    expect(store.assignments(cid, 'upcoming').map((a) => a.title)).toEqual(['Next week']);
    expect(store.assignments(cid, 'missing')).toHaveLength(0);
    expect(store.assignments(cid, 'all')).toHaveLength(2);
  });

  it('marks every live assignment stale when the snapshot comes back empty', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const { id: tid } = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0 }, NOW);
    const { id: cid } = store.upsertCourse({ termId: tid, title: 'Science' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a1', title: 'Lab', status: 'missing' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a2', title: 'Quiz', status: 'scored' }, NOW);

    expect(store.markStaleAssignments(cid, new Set())).toBe(2);
    // Already stale rows are not re-counted on the next empty snapshot.
    expect(store.markStaleAssignments(cid, new Set())).toBe(0);
    expect(store.recomputeMissingCount(cid)).toBe(0);
  });

  it('hides a course and stales its assignments when it vanishes from a complete term snapshot', () => {
    const { id: sid } = store.upsertStudent({ parentvueId: 'p1', name: 'Aiden', school: 'Odle' }, NOW);
    const { id: tid } = store.upsertTerm({ studentId: sid, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0 }, NOW);
    const { id: cid } = store.upsertCourse({ termId: tid, title: 'Dropped Science' }, NOW);
    store.upsertAssignment({ courseId: cid, extKey: 'a1', title: 'Old Lab', status: 'missing' }, NOW);
    store.recomputeMissingCount(cid);

    expect(store.markStaleCourses(tid, new Set())).toBe(1);
    expect(store.courses(tid)).toEqual([]);
    expect(store.missing(sid, tid)).toEqual([]);
    expect(() => store.resolveCourse(cid)).toThrow(/No course matches/);
  });

  it('records sync runs with a caller-supplied finish time', () => {
    const id = store.beginSyncRun(NOW, 'scheduled');
    const finishedAt = new Date('2026-09-13T12:00:05.000Z');
    store.finishSyncRun(id, 'ok', { students: [], errors: [], durationMs: 5 }, finishedAt);
    expect(store.lastSyncRun()).toMatchObject({
      id,
      status: 'ok',
      startedAt: NOW,
      finishedAt: '2026-09-13T12:00:05.000Z',
    });
    expect(store.counts()).toMatchObject({ students: 0, terms: 0, courses: 0, assignments: 0 });
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
