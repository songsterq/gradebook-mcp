import { describe, expect, it, beforeEach } from 'vitest';
import { ParentVueClient } from '../../lib/parentvue/src/index.js';
import { migrate, openDatabase } from '../../storage/sqlite.js';
import { newId, renderMissing, renderOverview, renderSyncSummary, schoolYearForDate } from './logic.js';
import { MIGRATIONS } from './migrations.js';
import { GradebookStore } from './store.js';
import { createSyncGate, diffIntoStore, runSync } from './sync.js';

const CHILDREN_DATA = {
  children: {
    childrenList: [
      { childIntID: 0, childName: 'Aiden Chien', organizationName: 'Odle Middle School', grade: '06' },
      { childIntID: 1, childName: 'Andrew Chien', organizationName: 'Medina Elementary', grade: '03' },
    ],
  },
};

function assignmentRow(o: {
  id: number;
  title: string;
  category: string;
  date: string;
  dueDate: string;
  score: string | null;
  displayScore: string;
  scoreType: string;
  points: string;
  notes: string;
}) {
  return {
    gradebookID: o.id,
    measure: o.title,
    type: o.category,
    date: o.date,
    dueDate: o.dueDate,
    score: o.score,
    displayScore: o.displayScore,
    scoreType: o.scoreType,
    points: o.points,
    point: null,
    pointPossible: null,
    notes: o.notes,
  };
}

function gradebookBook(assignments: unknown[], letter = 'B', score = '3.0') {
  return {
    type: 'Traditional',
    errorMessage: null,
    reportingPeriods: [{ index: 0, gradePeriod: 'Quarter 1', startDate: '09/02/2026', endDate: '11/06/2026' }],
    courses: [
      {
        period: 2,
        title: 'AL 6th Grade Science',
        room: 'B204',
        staff: 'Dylan Scott',
        staffEMail: 'scottd@example.test',
        marks: [
          {
            markName: 'Quarter 1',
            calculatedScoreString: letter,
            calculatedScoreRaw: score,
            assignments,
          },
        ],
      },
    ],
  };
}

const ASSIGNMENTS_V1 = [
  assignmentRow({
    id: 1, title: 'Student Survey', category: 'Habits', date: '09/04/2026', dueDate: '09/04/2026',
    score: '3.5', displayScore: '3.5 out of 4', scoreType: 'Raw Score', points: '4', notes: '',
  }),
  assignmentRow({
    id: 2, title: 'Syllabus Signature', category: 'Homework', date: '09/08/2026', dueDate: '09/11/2026',
    score: null, displayScore: 'Not Graded', scoreType: 'Raw Score', points: '10 Points Possible', notes: 'Missing',
  }),
];

const ASSIGNMENTS_V2 = [
  assignmentRow({
    id: 1, title: 'Student Survey', category: 'Habits', date: '09/04/2026', dueDate: '09/04/2026',
    score: '3.5', displayScore: '3.5 out of 4', scoreType: 'Raw Score', points: '4', notes: '',
  }),
  assignmentRow({
    id: 3, title: 'Lab Report', category: 'Lab', date: '09/10/2026', dueDate: '09/20/2026',
    score: null, displayScore: 'Not Graded', scoreType: 'Raw Score', points: '20 Points Possible', notes: '',
  }),
];

interface ChildBook {
  assignments: unknown[];
  letter?: string;
  score?: string;
}

function mockClient(gradebookFor: Record<string, ChildBook>, failChildren: string[] = []): ParentVueClient {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop() ?? '';
    const body = typeof init?.body === 'string' ? init.body : '{}';
    const inner = JSON.parse(JSON.parse(body).arguments.request);
    if (method === 'AttemptLogin') {
      return new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'r' }), { status: 200 });
    }
    if (method === 'GetChildListData') {
      return new Response(JSON.stringify({ error: null, data: CHILDREN_DATA }), { status: 200 });
    }
    if (method === 'Gradebook') {
      const id = String(inner.childIntID);
      if (failChildren.includes(id)) return new Response('boom', { status: 500 });
      const entry = gradebookFor[id] ?? { assignments: [] };
      return new Response(
        JSON.stringify({
          error: null,
          data: { traditionalGradebook: gradebookBook(entry.assignments, entry.letter, entry.score) },
        }),
        { status: 200 },
      );
    }
    throw new Error('unexpected method');
  }) as typeof fetch;
  return new ParentVueClient({ host: 'pxp.example.test', username: 'u', password: 'p', fetchImpl });
}

function freshStore(): GradebookStore {
  const db = openDatabase(':memory:');
  migrate(db, MIGRATIONS);
  return new GradebookStore(db);
}

const NOW = new Date('2026-09-13T12:00:00.000Z');

describe('runSync', () => {
  let store: GradebookStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('syncs both children and is idempotent', async () => {
    const client = mockClient({ '0': { assignments: ASSIGNMENTS_V1 }, '1': { assignments: [] } });
    const first = await runSync({ client, store, trigger: 'mcp', now: NOW });
    expect(first.status).toBe('ok');
    expect(first.students).toHaveLength(2);
    expect(first.students[0]).toMatchObject({ newScores: 1, rescored: 0 });
    expect(store.lastSyncRun()?.detail).toMatchObject({ students: [{ newScores: 1, rescored: 0 }, { newScores: 0, rescored: 0 }] });
    expect(store.counts()).toMatchObject({ students: 2, terms: 2, courses: 2, assignments: 2 });

    const second = await runSync({ client, store, trigger: 'mcp', now: new Date('2026-09-14T12:00:00.000Z') });
    expect(second.status).toBe('ok');
    expect(second.students[0]).toMatchObject({ newScores: 0, rescored: 0 });
    expect(store.counts()).toMatchObject({ students: 2, terms: 2, courses: 2, assignments: 2 });

    // One history entry per course: re-syncing unchanged data appends nothing.
    const aiden = store.resolveStudent('Aiden Chien');
    const term = store.latestTerm(aiden.id)!;
    const course = store.courses(term.id)[0]!;
    expect(store.trend(course.id)).toHaveLength(1);
  });

  it('reports rescored assignments in the run detail and summary', async () => {
    const initial = mockClient({ '0': { assignments: ASSIGNMENTS_V1 } });
    await runSync({ client: initial, store, trigger: 'mcp', now: NOW });
    const changed = ASSIGNMENTS_V1.map((row, index) => index === 0
      ? { ...row, score: '4.0', displayScore: '4 out of 4' }
      : row);
    const result = await runSync({
      client: mockClient({ '0': { assignments: changed } }), store, trigger: 'mcp',
      now: new Date('2026-09-14T12:00:00.000Z'),
    });
    expect(result.students[0]).toMatchObject({ newScores: 0, rescored: 1 });
    const summary = store.lastSyncRun()!;
    expect(summary.detail).toMatchObject({ students: [{ newScores: 0, rescored: 1 }, { newScores: 0, rescored: 0 }] });
    expect(renderSyncSummary(summary)).toContain('1 rescored');
    expect(renderSyncSummary(summary)).not.toContain('new scores');
    const initialRun = { ...summary, detail: { students: [{ name: 'Aiden', courses: 1, assignments: 1, newMissing: 0, newScores: 1, rescored: 0 }] } };
    expect(renderSyncSummary(initialRun)).toContain('1 new scores');
  });

  it('marks vanished assignments stale and counts newly missing work', async () => {
    const v1 = mockClient({ '0': { assignments: ASSIGNMENTS_V1 } });
    await runSync({ client: v1, store, trigger: 'mcp', now: NOW, studentAllowlist: ['Aiden Chien'] });

    const v2 = mockClient({ '0': { assignments: ASSIGNMENTS_V2 } });
    const result = await runSync({ client: v2, store, trigger: 'mcp', now: new Date('2026-09-14T12:00:00.000Z'), studentAllowlist: ['Aiden Chien'] });
    expect(result.status).toBe('ok');

    const aiden = store.resolveStudent('Aiden Chien');
    const course = store.courses(store.latestTerm(aiden.id)!.id)[0]!;
    const all = store.assignments(course.id, 'all');
    expect(all.find((a) => a.extKey === '2')?.stale).toBe(true);
    expect(all.find((a) => a.extKey === '3')?.status).toBe('not_due');
    // Syllabus Signature was already missing in v1, Lab Report is not due yet.
    expect(result.students[0]?.newMissing).toBe(0);
  });

  it('appends grade history when the posted grade changes', async () => {
    const v1 = mockClient({ '0': { assignments: ASSIGNMENTS_V1 } });
    await runSync({ client: v1, store, trigger: 'mcp', now: NOW, studentAllowlist: ['Aiden Chien'] });

const v2 = mockClient({ '0': { assignments: ASSIGNMENTS_V1, letter: 'A', score: '4.0' } });
    await runSync({ client: v2, store, trigger: 'mcp', now: new Date('2026-09-14T12:00:00.000Z'), studentAllowlist: ['Aiden Chien'] });

    const aiden = store.resolveStudent('Aiden Chien');
    const course = store.courses(store.latestTerm(aiden.id)!.id)[0]!;
    expect(course.gradeLetter).toBe('A');
    expect(store.trend(course.id).map((p) => p.gradeLetter)).toEqual(['B', 'A']);
  });

  it('keeps going when one child fails (partial)', async () => {
    const client = mockClient({ '0': { assignments: ASSIGNMENTS_V1 } }, ['1']);
    const result = await runSync({ client, store, trigger: 'mcp', now: NOW });
    expect(result.status).toBe('partial');
    expect(result.students).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(store.lastSyncRun()?.status).toBe('partial');
  });

  it('records an error run when the child list fails', async () => {
    const fetchImpl = (async () => new Response('down', { status: 500 })) as typeof fetch;
    const client = new ParentVueClient({ host: 'pxp.example.test', username: 'u', password: 'p', fetchImpl });
    const result = await runSync({ client, store, trigger: 'mcp', now: NOW });
    expect(result.status).toBe('error');
    expect(store.lastSyncRun()?.status).toBe('error');
  });
});

describe('diffIntoStore', () => {
  it('derives the school year from the period start date', () => {
    const store = freshStore();
    const result = diffIntoStore(
      store,
      {
        child: { id: '111', name: 'Aiden Chien', raw: {} },
        info: undefined,
        gradebook: {
          childId: '111',
          reportingPeriods: [{ index: 0, gu: 'g', name: 'Quarter 1', startDate: '2026-09-02', endDate: '2026-11-06' }],
          courses: [],
        },
      },
      NOW.toISOString(),
      '2026-09-13',
    );
    expect(result.courses).toBe(0);
    const term = store.latestTerm(result.studentId)!;
    expect(term.schoolYear).toBe('2026-2027');
    expect(term.reportingPeriod).toBe('Quarter 1');
  });

  it('stales a course that disappears from a successfully fetched period', () => {
    const store = freshStore();
    const period = { index: 0, gu: '', name: 'Quarter 1', startDate: '2026-09-02', endDate: '2026-11-06' };
    const child = { id: '111', name: 'Aiden Chien', raw: {} };
    diffIntoStore(
      store,
      {
        child,
        info: undefined,
        gradebook: {
          childId: child.id,
          reportingPeriods: [period],
          completePeriodIndexes: [0],
          courses: [{
            title: 'Science',
            marks: [{
              reportingPeriod: period,
              periodIndex: 0,
              letter: 'B',
              score: 3,
              assignments: [{
                id: '1',
                title: 'Lab',
                status: 'missing',
                raw: {},
              }],
              raw: {},
            }],
            raw: {},
          }],
        },
      },
      NOW.toISOString(),
      '2026-09-13',
    );
    diffIntoStore(
      store,
      {
        child,
        info: undefined,
        gradebook: {
          childId: child.id,
          reportingPeriods: [period],
          completePeriodIndexes: [0],
          courses: [],
        },
      },
      '2026-09-14T12:00:00.000Z',
      '2026-09-14',
    );

    const student = store.resolveStudent('Aiden Chien');
    const term = store.latestTerm(student.id, '2026-09-14')!;
    expect(store.courses(term.id)).toEqual([]);
    expect(store.missing(student.id, term.id)).toEqual([]);
  });
});

describe('multi-period course merging', () => {
  const periods = [
    { index: 0, gu: '', name: 'Quarter 1', startDate: '2026-09-02', endDate: '2026-11-06' },
    { index: 1, gu: '', name: 'Semester 1 Final', startDate: '2026-11-09', endDate: '2027-01-28' },
    { index: 2, gu: '', name: 'Quarter 3', startDate: '2027-02-01', endDate: '2027-04-09' },
    { index: 3, gu: '', name: 'Semester 2 Final', startDate: '2027-04-19', endDate: '2027-06-23' },
  ];
  const child = { id: '111', name: 'Aiden Chien', raw: {} };
  const work = (id: string, title: string, status: 'missing' | 'scored' | 'not_due' = 'scored') => ({
    id,
    title,
    status,
    raw: {},
  });
  const mark = (periodIndex: number, assignments: ReturnType<typeof work>[], letter = 'B') => ({
    reportingPeriod: periods[periodIndex]!,
    periodIndex,
    letter,
    score: letter === 'A' ? 4 : 3,
    assignments,
    raw: {},
  });
  const book = (
    courses: Array<{ title: string; marks: ReturnType<typeof mark>[] }>,
    completePeriodIndexes: number[],
  ) => ({
    childId: child.id,
    reportingPeriods: periods,
    completePeriodIndexes,
    courses: courses.map((course) => ({ ...course, raw: {} })),
  });

  it('stores one course, one assignment row, and one mark per period idempotently', () => {
    const store = freshStore();
    const shared = work('shared', 'Shared Quiz');
    const snapshot = book([{ title: 'Science', marks: [mark(0, [shared]), mark(1, [shared], 'A')] }], [0, 1]);

    const first = diffIntoStore(store, { child, info: undefined, gradebook: snapshot }, NOW.toISOString(), '2026-09-13');
    const second = diffIntoStore(store, { child, info: undefined, gradebook: snapshot }, NOW.toISOString(), '2026-09-13');
    const student = store.resolveStudent(child.name);
    const q1 = store.resolveTerm(student.id, '2026-2027', 'Quarter 1');
    const s1 = store.resolveTerm(student.id, '2026-2027', 'Semester 1 Final');

    expect(first.courses).toBe(1);
    expect(second.courses).toBe(1);
    expect(store.counts()).toMatchObject({ courses: 1, assignments: 1 });
    expect(store.courses(q1.id)).toHaveLength(1);
    expect(store.courses(s1.id)).toHaveLength(1);
    expect(store.courses(q1.id)[0]?.id).toBe(store.courses(s1.id)[0]?.id);
    expect(store.courses(q1.id)[0]?.gradeLetter).toBe('B');
    expect(store.courses(s1.id)[0]?.gradeLetter).toBe('A');
    const courseId = store.courses(q1.id)[0]!.id;
    expect(store.assignments(courseId, 'all').map((assignment) => assignment.extKey)).toEqual(['shared']);
    expect(store.trend(courseId)).toHaveLength(1);
  });

  it('counts a duplicated scored listing once in a run', () => {
    const store = freshStore();
    const shared = { ...work('shared', 'Shared Quiz'), score: 3.5, scoreRaw: '3.5', pointsPossible: 4 };
    const snapshot = book([{ title: 'Science', marks: [mark(0, [shared]), mark(1, [shared])] }], [0, 1]);
    const first = diffIntoStore(store, { child, info: undefined, gradebook: snapshot }, NOW.toISOString(), '2026-09-13');
    const second = diffIntoStore(store, { child, info: undefined, gradebook: snapshot }, '2026-09-14T12:00:00.000Z', '2026-09-14');
    expect(first).toMatchObject({ assignments: 1, newScores: 1, rescored: 0 });
    expect(second).toMatchObject({ assignments: 1, newScores: 0, rescored: 0 });
    const cid = store.courses(store.resolveTerm(first.studentId, '2026-2027', 'Quarter 1').id)[0]!.id;
    expect(store.assignments(cid, 'all')[0]).toMatchObject({ scoredAt: NOW.toISOString(), firstSeenAt: NOW.toISOString() });
    expect(store.assignments(cid, 'all')[0]).not.toHaveProperty('history');
  });

  it('keeps shared work live until every complete period drops it', () => {
    const store = freshStore();
    const shared = work('shared', 'Shared Quiz');
    diffIntoStore(store, {
      child,
      info: undefined,
      gradebook: book([{ title: 'Science', marks: [mark(0, [shared]), mark(1, [shared])] }], [0, 1]),
    }, NOW.toISOString(), '2026-09-13');
    diffIntoStore(store, {
      child,
      info: undefined,
      gradebook: book([{ title: 'Science', marks: [mark(0, []), mark(1, [shared])] }], [0, 1]),
    }, '2026-09-14T12:00:00.000Z', '2026-09-14');

    const student = store.resolveStudent(child.name);
    const q1 = store.resolveTerm(student.id, '2026-2027', 'Quarter 1');
    const s1 = store.resolveTerm(student.id, '2026-2027', 'Semester 1 Final');
    const course = store.courses(q1.id)[0]!;
    expect(store.assignments(course.id, 'all', q1.id)).toEqual([]);
    expect(store.assignments(course.id, 'all', s1.id)).toHaveLength(1);
    expect(store.assignments(course.id, 'all')[0]?.stale).toBe(false);

    diffIntoStore(store, {
      child,
      info: undefined,
      gradebook: book([{ title: 'Science', marks: [mark(0, []), mark(1, [])] }], [0, 1]),
    }, '2026-09-15T12:00:00.000Z', '2026-09-15');
    expect(store.assignments(course.id, 'all')[0]?.stale).toBe(true);
  });

  it('leaves memberships alone when a reporting-period fetch failed', () => {
    const store = freshStore();
    const s1Only = work('s1', 'Semester Work');
    diffIntoStore(store, {
      child,
      info: undefined,
      gradebook: book([{ title: 'Science', marks: [mark(0, []), mark(1, [s1Only])] }], [0, 1]),
    }, NOW.toISOString(), '2026-09-13');
    diffIntoStore(store, {
      child,
      info: undefined,
      gradebook: book([{ title: 'Science', marks: [mark(0, [])] }], [0]),
    }, '2026-09-14T12:00:00.000Z', '2026-09-14');

    const student = store.resolveStudent(child.name);
    const s1 = store.resolveTerm(student.id, '2026-2027', 'Semester 1 Final');
    const course = store.courses(s1.id)[0]!;
    expect(store.assignments(course.id, 'all', s1.id).map((assignment) => assignment.title)).toEqual(['Semester Work']);
    expect(store.assignments(course.id, 'all')[0]?.stale).toBe(false);
  });

  it('handles semester-only and later-starting courses without touching earlier periods', () => {
    const store = freshStore();
    const scienceQ1 = work('science-q1', 'Science Q1');
    const peWork = work('pe', 'PE Work');
    diffIntoStore(store, {
      child,
      info: undefined,
      gradebook: book([
        { title: 'Science', marks: [mark(0, [scienceQ1]), mark(1, [scienceQ1])] },
        { title: 'PE 6th', marks: [mark(0, [peWork], 'A'), mark(1, [peWork], 'A')] },
      ], [0, 1, 2, 3]),
    }, NOW.toISOString(), '2026-09-13');

    const student = store.resolveStudent(child.name);
    const q1 = store.resolveTerm(student.id, '2026-2027', 'Quarter 1');
    const s1 = store.resolveTerm(student.id, '2026-2027', 'Semester 1 Final');
    const q3 = store.resolveTerm(student.id, '2026-2027', 'Quarter 3');
    const s2 = store.resolveTerm(student.id, '2026-2027', 'Semester 2 Final');
    const peId = store.courses(q1.id).find((course) => course.title === 'PE 6th')!.id;

    const algebraWork = work('algebra', 'Algebra Warmup');
    diffIntoStore(store, {
      child,
      info: undefined,
      gradebook: book([{ title: 'Algebra', marks: [mark(2, [algebraWork], 'A'), mark(3, [algebraWork], 'A')] }], [2, 3]),
    }, '2026-09-14T12:00:00.000Z', '2026-09-14');

    expect(store.courses(q1.id).map((course) => course.title)).toEqual(['PE 6th', 'Science']);
    expect(store.courses(s1.id).map((course) => course.title)).toEqual(['PE 6th', 'Science']);
    expect(store.courses(q3.id).map((course) => course.title)).toEqual(['Algebra']);
    expect(store.courses(s2.id).map((course) => course.title)).toEqual(['Algebra']);
    expect(store.resolveCourse(peId).course.title).toBe('PE 6th');
    const algebra = store.courses(q3.id)[0]!;
    expect(store.resolveCourse(algebra.id).course).toMatchObject({ termId: q3.id, gradeLetter: 'A' });
    expect(store.assignments(store.courses(q1.id).find((course) => course.title === 'Science')!.id, 'all', q1.id)).toHaveLength(1);
  });

  it('computes different missing counts from each period membership', () => {
    const store = freshStore();
    const missing = work('missing', 'Q1 Missing', 'missing');
    diffIntoStore(store, {
      child,
      info: undefined,
      gradebook: book([{ title: 'Science', marks: [mark(0, [missing]), mark(1, [])] }], [0, 1]),
    }, NOW.toISOString(), '2026-09-13');
    const student = store.resolveStudent(child.name);
    const q1 = store.resolveTerm(student.id, '2026-2027', 'Quarter 1');
    const s1 = store.resolveTerm(student.id, '2026-2027', 'Semester 1 Final');
    expect(store.courses(q1.id)[0]?.missingCount).toBe(1);
    expect(store.courses(s1.id)[0]?.missingCount).toBe(0);
    expect(store.missing(student.id, q1.id)).toHaveLength(1);
    expect(store.missing(student.id, s1.id)).toHaveLength(0);
  });
});

describe('reporting period identity', () => {
  it('files each mark under the period index upstream gave it, not its array position', () => {
    const store = freshStore();
    // Some districts number periods from 0, but the index is upstream's to
    // choose — and it doubles as the `reportPeriod` request parameter. Keying
    // terms on array position silently files marks under the wrong quarter.
    const periods = [
      { index: 1, gu: '', name: 'Quarter 1', startDate: '2026-09-02', endDate: '2026-11-06' },
      { index: 2, gu: '', name: 'Quarter 2', startDate: '2026-11-09', endDate: '2027-01-29' },
    ];
    const result = diffIntoStore(
      store,
      {
        child: { id: '111', name: 'Aiden Chien', raw: {} },
        info: undefined,
        gradebook: {
          childId: '111',
          reportingPeriods: periods,
          courses: [
            {
              title: 'Science',
              marks: [
                { reportingPeriod: periods[0]!, periodIndex: 1, letter: 'B', score: 3, assignments: [], raw: {} },
              ],
              raw: {},
            },
          ],
        },
      },
      NOW.toISOString(),
      '2026-09-13',
    );

    const terms = store.terms(result.studentId);
    expect(terms).toHaveLength(2);
    const q1 = terms.find((t) => t.reportingPeriod === 'Quarter 1')!;
    const q2 = terms.find((t) => t.reportingPeriod === 'Quarter 2')!;
    expect(store.courses(q1.id).map((c) => c.title)).toEqual(['Science']);
    expect(store.courses(q2.id)).toEqual([]);
    // No phantom "Period N" term from the defensive fallback.
    expect(terms.map((t) => t.reportingPeriod).sort()).toEqual(['Quarter 1', 'Quarter 2']);
  });

  it('falls back to a synthetic term for a mark no reporting period covers', () => {
    const store = freshStore();
    const result = diffIntoStore(
      store,
      {
        child: { id: '111', name: 'Aiden Chien', raw: {} },
        info: undefined,
        gradebook: {
          childId: '111',
          reportingPeriods: [],
          courses: [
            { title: 'Science', marks: [{ reportingPeriod: null, periodIndex: 4, letter: 'A', score: 4, assignments: [], raw: {} }], raw: {} },
          ],
        },
      },
      NOW.toISOString(),
      '2026-09-13',
    );
    expect(store.terms(result.studentId).map((t) => t.reportingPeriod)).toEqual(['Period 5']);
  });
});

describe('sync API economy', () => {
  it('does not spend a second child-list round trip per child', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = url.split('/').pop() ?? '';
      calls.push(method);
      const body = typeof init?.body === 'string' ? init.body : '{}';
      const inner = JSON.parse(JSON.parse(body).arguments.request);
      if (method === 'AttemptLogin') {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      if (method === 'GetChildListData') {
        return new Response(JSON.stringify({ error: null, data: CHILDREN_DATA }), { status: 200 });
      }
      void inner;
      return new Response(
        JSON.stringify({ error: null, data: { traditionalGradebook: gradebookBook([]) } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new ParentVueClient({ host: 'pxp.example.test', username: 'u', password: 'p', fetchImpl });

    const store = freshStore();
    await runSync({ client, store, trigger: 'mcp', now: NOW });

    // School and grade level still land, from the one child-list response.
    expect(calls.filter((m) => m === 'GetChildListData')).toHaveLength(1);
    expect(store.resolveStudent('Aiden Chien').school).toBe('Odle Middle School');
    expect(store.resolveStudent('Andrew Chien').gradeLevel).toBe('03');
  });
});

describe('createSyncGate', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('coalesces concurrent callers into one run', async () => {
    const gate1 = deferred();
    let runs = 0;
    const gate = createSyncGate(
      () => {
        runs += 1;
        return gate1.promise;
      },
      { cooldownMs: 0 },
    );

    const first = gate({ trigger: 'mcp' });
    const second = gate({ trigger: 'mcp' });
    const third = gate({ cooldown: true, trigger: 'dashboard' });
    gate1.resolve();

    expect(await first).toBe('ran');
    expect(await second).toBe('joined');
    expect(await third).toBe('joined');
    expect(runs).toBe(1);
  });

  it('runs again once the previous run has settled', async () => {
    let runs = 0;
    const gate = createSyncGate(async () => {
      runs += 1;
    }, { cooldownMs: 0 });

    expect(await gate({ trigger: 'mcp' })).toBe('ran');
    expect(await gate({ trigger: 'mcp' })).toBe('ran');
    expect(runs).toBe(2);
  });

  it('refuses a cooldown caller inside the window but never the tool', async () => {
    let clock = 1_000;
    let runs = 0;
    const gate = createSyncGate(async () => {
      runs += 1;
    }, { cooldownMs: 60_000, now: () => clock });

    // The very first dashboard press is not penalised by the initial window.
    expect(await gate({ cooldown: true, trigger: 'dashboard' })).toBe('ran');
    clock += 30_000;
    expect(await gate({ cooldown: true, trigger: 'dashboard' })).toBe('cooldown');
    // The authenticated MCP tool does not opt into the cooldown.
    expect(await gate({ trigger: 'mcp' })).toBe('ran');
    clock += 60_000;
    expect(await gate({ cooldown: true, trigger: 'dashboard' })).toBe('ran');
    expect(runs).toBe(3);
  });

  it('releases the gate when a run fails, and propagates to joiners', async () => {
    const failing = deferred();
    let runs = 0;
    const gate = createSyncGate(
      () => {
        runs += 1;
        return runs === 1 ? failing.promise : Promise.resolve();
      },
      { cooldownMs: 0 },
    );

    const first = gate({ trigger: 'mcp' });
    const joiner = gate({ trigger: 'mcp' });
    failing.reject(new Error('upstream down'));

    await expect(first).rejects.toThrow('upstream down');
    await expect(joiner).rejects.toThrow('upstream down');
    // Not wedged: the next caller starts a fresh run.
    expect(await gate({ trigger: 'mcp' })).toBe('ran');
    expect(runs).toBe(2);
  });
});

describe('logic helpers', () => {
  it('newId uses the gradebook prefixes and unambiguous alphabet', () => {
    const id = newId('stu');
    expect(id).toMatch(/^stu_[A-Za-z2-9]{8}$/);
    expect(id).not.toMatch(/[01IlO]/);
    expect(newId('asn')).not.toBe(newId('asn'));
  });

  it('schoolYearForDate splits at August', () => {
    expect(schoolYearForDate('2026-09-02')).toBe('2026-2027');
    expect(schoolYearForDate('2026-08-01')).toBe('2026-2027');
    expect(schoolYearForDate('2026-07-31')).toBe('2025-2026');
    expect(schoolYearForDate('2027-01-15')).toBe('2026-2027');
  });

  it('renderMissing lists items with context', () => {
    const text = renderMissing(
      [{
        id: 'asn_x', courseId: 'crs_y', extKey: '1', title: 'Syllabus Signature',
        category: 'Homework', dueDate: '2026-09-11', pointsPossible: 10,
        score: null, scoreRaw: null, scoreLetter: null, status: 'missing', notes: null,
        firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), scoredAt: null, stale: false,
        studentId: 'stu_a', studentName: 'Aiden Chien', courseTitle: 'Math', termLabel: '2026-2027 · Q1',
      }],
      'Aiden Chien',
    );
    expect(text).toContain('Syllabus Signature');
    expect(text).toContain('Math');
    expect(text).toContain('2026-09-11');
  });

  it('renderOverview handles students with no terms', () => {
    expect(renderOverview([])).toContain('No students');
    expect(renderOverview([{
      student: {
        id: 'stu_a', parentvueId: '1', name: 'Aiden', school: 'Odle',
        gradeLevel: null, firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(),
      },
      term: null,
      courses: [],
    }])).toContain('No synced terms');
  });
});
