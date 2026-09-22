import { randomBytes } from 'node:crypto';
import type {
  Assignment,
  Course,
  GradePoint,
  MissingAssignment,
  Student,
  ScorePoint,
  SyncRunSummary,
  Term,
  WhatsNew,
  WhatsNewItem,
} from './schema.js';

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export type IdPrefix = 'stu' | 'trm' | 'crs' | 'mrk' | 'asn';

/** Generate a short copy-friendly id, rejecting bytes that would introduce modulo bias. */
export function newId(prefix: IdPrefix): string {
  let suffix = '';
  const unbiasedLimit = Math.floor(256 / ID_ALPHABET.length) * ID_ALPHABET.length;

  while (suffix.length < 8) {
    for (const byte of randomBytes(8 - suffix.length)) {
      if (byte >= unbiasedLimit) continue;
      suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
  }

  return `${prefix}_${suffix}`;
}

/**
 * School year for a date: a period starting in August or later belongs to the
 * year it starts in (`2026-09-02` → `2026-2027`); earlier months belong to the
 * year that started the previous August.
 */
export function schoolYearForDate(ymd: string | undefined, fallback: Date = new Date()): string {
  const source = ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : fallback.toISOString().slice(0, 10);
  const year = Number(source.slice(0, 4));
  const month = Number(source.slice(5, 7));
  return month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

export function termLabel(term: Term): string {
  return `${term.schoolYear} · ${term.reportingPeriod}`;
}

export function describeGrade(course: Pick<Course, 'gradeLetter' | 'gradeScore'>): string {
  const letter = course.gradeLetter?.trim();
  if (letter && course.gradeScore !== null && course.gradeScore !== undefined) {
    return `${letter} (${course.gradeScore})`;
  }
  return letter || 'no grade posted';
}

/** Identity of a score for change detection; null when there is no score. */
export function scoreKey(score: number | null, scoreRaw: string | null): string | null {
  if (score !== null) return `n:${score}`;
  const raw = scoreRaw?.trim();
  return raw ? `r:${raw}` : null;
}

export function describeScore(a: Pick<Assignment, 'score' | 'scoreRaw' | 'scoreLetter' | 'pointsPossible'>): string {
  if (a.score !== null && a.score !== undefined && a.pointsPossible !== null && a.pointsPossible !== undefined) {
    return `${a.score}/${a.pointsPossible}`;
  }
  if (a.score !== null && a.score !== undefined) return `${a.score}`;
  if (a.scoreLetter) return a.scoreLetter;
  if (a.scoreRaw) return a.scoreRaw;
  return '—';
}

export function describeScoreTrail(points: ScorePoint[]): string {
  return points.map(describeScore).join(' → ');
}

const STATUS_LABEL: Record<string, string> = {
  missing: 'Missing',
  late: 'Late',
  incomplete: 'Incomplete',
  collected: 'Collected',
  not_due: 'Not due',
  excused: 'Excused',
  scored: 'Scored',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export interface OverviewStudent {
  student: Student;
  term: Term | null;
  courses: Course[];
  whatsNew: WhatsNew;
}

export function whatsNewLabel(kind: WhatsNewItem['kind']): string {
  return kind === 'new_assignment' ? 'new assignment' : kind === 'new_score' ? 'new score' : 'score changed';
}

export function renderOverview(students: OverviewStudent[]): string {
  if (students.length === 0) {
    return 'No students on file yet. Run gradebook_sync to pull ParentVUE.';
  }
  const lines: string[] = [];
  for (const { student, term, courses, whatsNew } of students) {
    lines.push(`## ${student.name} — ${student.school}`);
    if (!term) {
      lines.push('No synced terms yet.');
    } else {
      lines.push(`*${termLabel(term)}*`);
      if (courses.length === 0) lines.push('No courses this term.');
      for (const course of courses) {
        const missing = course.missingCount > 0 ? ` · ${course.missingCount} missing` : '';
        lines.push(`- ${course.title}: ${describeGrade(course)}${missing} (${course.id})`);
      }
    }
    if (whatsNew.items.length > 0) {
      lines.push(`What's new since ${whatsNew.since}`);
      for (const item of whatsNew.items) {
        lines.push(`- ${item.assignment.title} (${item.courseTitle}) · ${whatsNewLabel(item.kind)} · ${describeScore(item.assignment)}`);
      }
    }
  }
  return lines.join('\n');
}

export function renderTerms(student: Student, terms: Term[]): string {
  if (terms.length === 0) return `${student.name} has no synced terms yet.`;
  const lines = [`## ${student.name} — terms`];
  for (const term of terms) {
    const range = term.periodStart ? ` (${term.periodStart} → ${term.periodEnd ?? '?'})` : '';
    lines.push(
      `- ${termLabel(term)}${range}: ${term.courseCount} courses, ${term.missingCount} missing`,
    );
  }
  return lines.join('\n');
}

export function renderCourses(student: Student, term: Term, courses: Course[]): string {
  const lines = [`## ${student.name} — ${termLabel(term)}`];
  if (courses.length === 0) {
    lines.push('No courses this term.');
    return lines.join('\n');
  }
  for (const c of courses) {
    const teacher = c.teacher ? ` · ${c.teacher}` : '';
    const missing = c.missingCount > 0 ? ` · ${c.missingCount} missing` : '';
    lines.push(`- **${c.title}**${teacher}: ${describeGrade(c)}${missing} (${c.id})`);
  }
  return lines.join('\n');
}

export function renderAssignments(course: Course, assignments: (Assignment & { new?: boolean })[], filter: string): string {
  const lines = [`## ${course.title} — ${filter}`];
  if (assignments.length === 0) {
    lines.push('Nothing here.');
    return lines.join('\n');
  }
  for (const a of assignments) {
    const due = a.dueDate ? ` · due ${a.dueDate}` : '';
    const category = a.category ? ` · ${a.category}` : '';
    const stale = a.stale ? ' · (no longer listed upstream)' : '';
    const trail = a.history ? ` · was ${describeScoreTrail(a.history.slice(0, -1))}` : '';
    const fresh = a.new ? ' · new' : '';
    lines.push(
      `- ${a.title}: ${describeScore(a)} · ${statusLabel(a.status)}${trail}${due}${category}${stale}${fresh}`,
    );
  }
  return lines.join('\n');
}

export function renderMissing(items: MissingAssignment[], scope: string): string {
  const lines = [`## Missing work — ${scope}`];
  if (items.length === 0) {
    lines.push('Nothing missing. 🎉');
    return lines.join('\n');
  }
  for (const a of items) {
    const due = a.dueDate ? ` · due ${a.dueDate}` : ' · no due date';
    lines.push(
      `- **${a.title}** (${a.courseTitle}, ${a.studentName})${due} · ${a.category ?? 'no category'}`,
    );
  }
  return lines.join('\n');
}

export function renderTrend(course: Course, points: GradePoint[]): string {
  const lines = [`## ${course.title} — grade trend`];
  if (points.length === 0) {
    lines.push('No grade history yet.');
    return lines.join('\n');
  }
  for (const p of points) {
    lines.push(`- ${p.observedAt.slice(0, 10)}: ${describeGrade(p)}`);
  }
  return lines.join('\n');
}

export function renderSyncSummary(summary: SyncRunSummary): string {
  const detail = summary.detail as {
    students?: Array<{ name: string; courses: number; assignments: number; newMissing: number; newScores?: number; rescored?: number }>;
    errors?: string[];
    durationMs?: number;
  };
  const lines = [
    `## Sync ${summary.status}`,
    `Run #${summary.id} · ${summary.trigger} · started ${summary.startedAt}`,
  ];
  for (const s of detail.students ?? []) {
    lines.push(
      `- ${s.name}: ${s.courses} courses, ${s.assignments} assignments, ${s.newMissing} newly missing${s.newScores ? `, ${s.newScores} new scores` : ''}${s.rescored ? `, ${s.rescored} rescored` : ''}`,
    );
  }
  for (const e of detail.errors ?? []) {
    lines.push(`- Error: ${e}`);
  }
  if (detail.durationMs !== undefined) lines.push(`Took ${Math.round(detail.durationMs / 100) / 10}s.`);
  return lines.join('\n');
}

export function renderStatus(status: {
  configured: boolean;
  schedulerArmed: boolean;
  lastRun: SyncRunSummary | null;
  lastScheduledRun: SyncRunSummary | null;
  counts: { students: number; terms: number; courses: number; assignments: number };
}): string {
  const lines = ['## Gradebook status'];
  lines.push(`ParentVUE: ${status.configured ? 'configured' : 'not configured'}`);
  if (status.lastRun) {
    lines.push(
      `Last sync: #${status.lastRun.id} ${status.lastRun.status} (${status.lastRun.trigger}) at ${status.lastRun.startedAt}`,
    );
  } else {
    lines.push('Last sync: never');
  }
  // Called out separately from `lastRun`: a manual sync would otherwise mask the
  // fact that the scheduler has never fired.
  lines.push(
    status.lastScheduledRun
      ? `Last automatic sync: #${status.lastScheduledRun.id} ${status.lastScheduledRun.status} at ${status.lastScheduledRun.startedAt}`
      : `Last automatic sync: never (${status.schedulerArmed ? 'scheduler armed' : 'scheduler off'})`,
  );
  const c = status.counts;
  lines.push(
    `On file: ${c.students} students, ${c.terms} terms, ${c.courses} courses, ${c.assignments} assignments`,
  );
  return lines.join('\n');
}
