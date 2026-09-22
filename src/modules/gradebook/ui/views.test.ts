import { describe, expect, it } from 'vitest';
import { renderDashboardPage } from './views.js';
import type { DashboardPageModel } from './views.js';

function model(overrides: Partial<DashboardPageModel> = {}): DashboardPageModel {
  return {
    students: [],
    activeStudent: null,
    terms: [],
    activeTerm: null,
    cards: [],
    whatsNew: { at: null, since: null, items: [] },
    missing: [],
    view: 'courses',
    configured: true,
    lastSyncAt: null,
    ...overrides,
  };
}

describe('renderDashboardPage', () => {
  it('shows empty state with a sync prompt when configured', () => {
    const page = renderDashboardPage(model()).__html;
    expect(page).toContain('No students on file yet');
    expect(page).toContain('Sync now');
  });

  it('warns when ParentVUE is not configured', () => {
    const page = renderDashboardPage(model({ configured: false })).__html;
    expect(page).toContain('ParentVUE is not configured');
    expect(page).toContain('disabled');
  });

  it('renders course cards with grades and missing badges', () => {
    const page = renderDashboardPage(model({
      students: [{ id: 'stu_a', parentvueId: '1', name: 'Aiden', school: 'Odle', gradeLevel: '06', firstSeenAt: 'x', lastSeenAt: 'x' }],
      activeStudent: { id: 'stu_a', parentvueId: '1', name: 'Aiden', school: 'Odle', gradeLevel: '06', firstSeenAt: 'x', lastSeenAt: 'x' },
      terms: [{ id: 'trm_t', studentId: 'stu_a', schoolYear: '2026-2027', reportingPeriod: 'Quarter 1', periodIndex: 0, periodStart: null, periodEnd: null, lastSyncedAt: null, courseCount: 1, missingCount: 1 }],
      activeTerm: { id: 'trm_t', studentId: 'stu_a', schoolYear: '2026-2027', reportingPeriod: 'Quarter 1', periodIndex: 0, periodStart: null, periodEnd: null, lastSyncedAt: null, courseCount: 1, missingCount: 1 },
      cards: [{
        course: { id: 'crs_c', termId: 'trm_t', title: 'AL 6th Grade Science', teacher: 'Dylan Scott', room: null, period: null, gradeLetter: 'A', gradeScore: 3.5, missingCount: 1, lastSyncedAt: null },
        assignments: [{
          id: 'asn_1', courseId: 'crs_c', extKey: '1', title: 'Syllabus Signature', category: 'Homework',
          dueDate: '2026-09-11', pointsPossible: 10, score: null, scoreRaw: null, scoreLetter: null,
          status: 'missing', notes: null, firstSeenAt: 'x', lastSeenAt: 'x', scoredAt: null, stale: false,
        }],
      }],
      missing: [{
        id: 'asn_1', courseId: 'crs_c', extKey: '1', title: 'Syllabus Signature', category: 'Homework',
        dueDate: '2026-09-11', pointsPossible: 10, score: null, scoreRaw: null, scoreLetter: null,
        status: 'missing', notes: null, firstSeenAt: 'x', lastSeenAt: 'x', scoredAt: null, stale: false,
        studentId: 'stu_a', studentName: 'Aiden', courseTitle: 'AL 6th Grade Science', termLabel: '2026-2027 · Quarter 1',
      }],
      lastSyncAt: '2026-09-13T12:00:00.000Z',
    })).__html;
    expect(page).toContain('AL 6th Grade Science');
    expect(page).toContain('3.5');
    expect(page).toContain('1 missing');
    expect(page).toContain('Syllabus Signature');
    expect(page).toContain('Missing work');
    expect(page).toContain('gb-tab-count">1<');
  });

  it('renders the missing view', () => {
    const student = { id: 'stu_a', parentvueId: '1', name: 'Aiden', school: 'Odle', gradeLevel: '06', firstSeenAt: 'x', lastSeenAt: 'x' };
    const page = renderDashboardPage(model({ view: 'missing', students: [student], activeStudent: student, missing: [] })).__html;
    expect(page).toContain('Nothing missing');
  });

  it('shows the trail only for changed score rows', () => {
    const course = { id: 'crs_a', termId: 'trm_a', title: 'Science', teacher: null, room: null, period: null, gradeLetter: null, gradeScore: null, missingCount: 0, lastSyncedAt: null };
    const base = { courseId: course.id, category: null, dueDate: null, pointsPossible: 4, score: 3.5, scoreRaw: '3.5', scoreLetter: null, status: 'scored' as const, notes: null, firstSeenAt: '2026-09-01', lastSeenAt: '2026-09-02', scoredAt: '2026-09-02', stale: false };
    const page = renderDashboardPage(model({
      students: [{ id: 'stu_a', parentvueId: 'p', name: 'Aiden', school: 'Odle', gradeLevel: null, firstSeenAt: 'x', lastSeenAt: 'x' }],
      cards: [{ course, assignments: [
        { ...base, id: 'asn_a', extKey: 'a', title: 'Changed', history: [
          { observedAt: '2026-09-01', score: 2.5, scoreRaw: '2.5', scoreLetter: null, pointsPossible: 4 },
          { observedAt: '2026-09-02', score: 3.5, scoreRaw: '3.5', scoreLetter: null, pointsPossible: 4 },
        ] },
        { ...base, id: 'asn_b', extKey: 'b', title: 'Unchanged' },
      ] }],
    })).__html;
    expect(page.match(/class="gb-trail"/g)).toHaveLength(1);
    expect(page).toContain('2.5/4 → 3.5/4');
    expect(page).toContain('title="2026-09-01 → 2026-09-02"');
  });

  it('shows new work above cards and marks every new row', () => {
    const student = { id: 'stu_a', parentvueId: 'p', name: 'Aiden', school: 'Odle', gradeLevel: null, firstSeenAt: 'x', lastSeenAt: 'x' };
    const course = { id: 'crs_a', termId: 'trm_a', title: 'Science', teacher: null, room: null, period: null, gradeLetter: null, gradeScore: null, missingCount: 0, lastSyncedAt: null };
    const assignment = { id: 'asn_new', courseId: course.id, extKey: 'a', title: 'New Lab', category: null, dueDate: null,
      pointsPossible: 4, score: 3, scoreRaw: '3', scoreLetter: null, status: 'scored' as const, notes: null,
      firstSeenAt: '2026-09-22T00:00:00.000Z', lastSeenAt: '2026-09-22T00:00:00.000Z', scoredAt: '2026-09-22T00:00:00.000Z', stale: false };
    const scored = { ...assignment, id: 'asn_score', extKey: 'b', title: 'Old Quiz', firstSeenAt: '2026-09-20T00:00:00.000Z' };
    const whatsNew = { at: '2026-09-22T00:00:00.000Z', since: '2026-09-21T00:00:00.000Z', items: [
      { kind: 'new_assignment' as const, assignment, courseId: course.id, courseTitle: course.title },
      { kind: 'new_score' as const, assignment: scored, courseId: course.id, courseTitle: course.title },
    ] };
    const page = renderDashboardPage(model({ students: [student], activeStudent: student,
      cards: [{ course, assignments: [assignment, scored] }], whatsNew, timeZone: 'America/Los_Angeles' })).__html;
    expect(page).toContain('New since <time datetime="2026-09-21T00:00:00.000Z">Sep 20, 2026, 5:00 PM</time>');
    expect(page.indexOf('gb-whats-new')).toBeLessThan(page.indexOf('gb-courses'));
    expect(page).toContain('new assignment');
    expect(page).toContain('new score');
    expect(page.match(/data-new="true"/g)).toHaveLength(2);
    expect(page).toMatch(/<tr data-new="true">\s*<td class="gb-title-cell"><span class="gb-new-dot"[^>]*><\/span>New Lab/);
    expect(page).toMatch(/data-new="true"[^>]*>\s*<td[^>]*><span class="gb-new-dot"[^>]*><\/span>Old Quiz/);
    const missing = renderDashboardPage(model({ students: [student], activeStudent: student, view: 'missing', whatsNew })).__html;
    expect(missing).not.toContain('gb-whats-new');
  });

  it('hides an empty panel and displays ISO date and time without a configured timezone', () => {
    const student = { id: 'stu_a', parentvueId: 'p', name: 'Aiden', school: 'Odle', gradeLevel: null, firstSeenAt: 'x', lastSeenAt: 'x' };
    expect(renderDashboardPage(model({ students: [student], activeStudent: student })).__html).not.toContain('gb-whats-new');
    const assignment = { id: 'asn_a', courseId: 'crs_a', extKey: 'a', title: 'Lab', category: null, dueDate: null,
      pointsPossible: null, score: null, scoreRaw: null, scoreLetter: null, status: 'collected' as const, notes: null,
      firstSeenAt: '2026-09-22T00:00:00.000Z', lastSeenAt: '2026-09-22T00:00:00.000Z', scoredAt: null, stale: false };
    const whatsNew = { at: '2026-09-22T00:00:00.000Z', since: '2026-09-21T00:00:00.000Z', items: [
      { kind: 'new_assignment' as const, assignment, courseId: 'crs_a', courseTitle: 'Science' },
    ] };
    expect(renderDashboardPage(model({ students: [student], activeStudent: student, whatsNew })).__html)
      .toContain('2026-09-21 00:00:00');
  });
});
