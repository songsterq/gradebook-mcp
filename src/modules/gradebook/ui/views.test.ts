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
});
