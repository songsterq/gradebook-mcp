import { html } from '../../../ui/html.js';
import type { Html } from '../../../ui/html.js';
import { describeGrade, describeScore, describeScoreTrail, statusLabel, termLabel } from '../logic.js';
import type { Assignment, Course, MissingAssignment, Student, Term } from '../schema.js';

export interface CourseCardModel {
  course: Course;
  assignments: Assignment[];
}

export interface DashboardPageModel {
  students: Student[];
  activeStudent: Student | null;
  terms: Term[];
  activeTerm: Term | null;
  cards: CourseCardModel[];
  missing: MissingAssignment[];
  view: 'courses' | 'missing';
  configured: boolean;
  lastSyncAt: string | null;
  banner?: string;
}

export interface ErrorPageModel {
  title: string;
  message: string;
}

function studentHref(studentId: string, termId: string | null, view: string): string {
  const params = new URLSearchParams({ student: studentId, view });
  if (termId) params.set('term', termId);
  return `/gradebook?${params.toString()}`;
}

function termHref(studentId: string, termId: string, view: string): string {
  const params = new URLSearchParams({ student: studentId, term: termId, view });
  return `/gradebook?${params.toString()}`;
}

function viewHref(studentId: string, termId: string | null, view: string): string {
  return studentHref(studentId, termId, view);
}

/** One pill in a picker row. The selected one is a span, not a link to itself. */
function tab(label: Html, href: string, active: boolean): Html {
  return active
    ? html`<span class="gb-tab" aria-current="page">${label}</span>`
    : html`<a class="gb-tab" href="${href}">${label}</a>`;
}

function pickerRow(label: string, tabs: Html[], trailing: Html | null = null): Html {
  return html`<div class="gb-bar" role="group" aria-label="${label}">
    <span class="gb-bar-label">${label}</span>${tabs}${trailing}
  </div>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `Sep 10` rather than `2026-09-10`: inside a single reporting period the year
 * never varies, and the full date stays available as the `datetime`/tooltip.
 */
function renderDate(ymd: string | null): Html {
  if (!ymd) return html`<span class="gb-dash">—</span>`;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!parts) return html`<span class="gb-date">${ymd}</span>`;
  const month = MONTHS[Number(parts[2]) - 1] ?? parts[2];
  return html`<time class="gb-date" datetime="${ymd}" title="${ymd}">${month} ${Number(parts[3])}</time>`;
}

function renderScore(a: Assignment): Html {
  const text = describeScore(a);
  const body = text === '—' ? html`<span class="gb-dash">—</span>` : html`<span class="gb-score">${text}</span>`;
  const trail = a.history
    ? html`<span class="gb-trail" title="${a.history.map((point) => point.observedAt.slice(0, 10)).join(' → ')}">${describeScoreTrail(a.history)}</span>`
    : null;
  if (a.score !== null && a.score !== undefined && a.pointsPossible) {
    return html`${body}<span class="gb-pct">${Math.round((a.score / a.pointsPossible) * 100)}%</span>${trail}`;
  }
  return html`${body}${trail}`;
}

const STATUS_TONE: Record<string, string> = {
  missing: 'bad',
  incomplete: 'bad',
  late: 'warn',
  scored: 'good',
  collected: 'info',
  not_due: 'flat',
  excused: 'flat',
};

/** A letter grade's tone, so a card reads at a glance without parsing the text. */
function gradeTone(gradeLetter: string | null): string {
  switch (gradeLetter?.trim().charAt(0).toUpperCase()) {
    case 'A':
      return 'good';
    case 'B':
      return 'info';
    case 'C':
      return 'warn';
    case 'D':
    case 'F':
      return 'bad';
    default:
      return 'flat';
  }
}

function renderGrade(course: Course): Html {
  const letter = course.gradeLetter?.trim();
  if (!letter) return html`<span class="gb-grade" data-tone="flat">No grade</span>`;
  const score =
    course.gradeScore !== null && course.gradeScore !== undefined
      ? html`<span class="gb-grade-score">${course.gradeScore}</span>`
      : null;
  return html`<span class="gb-grade" data-tone="${gradeTone(letter)}" title="${describeGrade(course)}">${letter}${score}</span>`;
}

function renderStudentTabs(model: DashboardPageModel): Html | null {
  if (model.students.length < 2) return null;
  return pickerRow(
    'Student',
    model.students.map((s) =>
      tab(
        html`${s.name}`,
        studentHref(s.id, model.activeTerm?.id ?? null, model.view),
        s.id === model.activeStudent?.id,
      ),
    ),
  );
}

function renderTermPicker(model: DashboardPageModel): Html | null {
  if (!model.activeStudent || model.terms.length === 0) return null;
  const student = model.activeStudent;
  return pickerRow(
    'Term',
    model.terms.map((t) =>
      tab(html`${t.reportingPeriod}`, termHref(student.id, t.id, model.view), t.id === model.activeTerm?.id),
    ),
    html`<span class="gb-year">${model.activeTerm?.schoolYear ?? ''}</span>`,
  );
}

function renderViewTabs(model: DashboardPageModel): Html | null {
  if (!model.activeStudent) return null;
  const student = model.activeStudent;
  const termId = model.activeTerm?.id ?? null;
  const count = model.missing.length;
  return pickerRow('View', [
    tab(html`Courses`, viewHref(student.id, termId, 'courses'), model.view === 'courses'),
    tab(
      html`Missing work${count > 0 ? html` <span class="gb-tab-count">${count}</span>` : null}`,
      viewHref(student.id, termId, 'missing'),
      model.view === 'missing',
    ),
  ]);
}

const FLAGGED = new Set(['missing', 'incomplete', 'late']);

function renderAssignmentRow(a: Assignment): Html {
  const status = html`<span class="gb-status" data-tone="${STATUS_TONE[a.status] ?? 'flat'}">${statusLabel(a.status)}</span>${a.stale ? html`<span class="gb-stale" title="No longer listed upstream">stale</span>` : null}`;
  return html`<tr${FLAGGED.has(a.status) ? html` data-flag="true"` : null}>
    <td class="gb-title-cell">${a.title}</td>
    <td class="gb-col-due">${renderDate(a.dueDate)}</td>
    <td class="gb-cat gb-col-cat">${a.category ?? html`<span class="gb-dash">—</span>`}</td>
    <td class="gb-num">${renderScore(a)}</td>
    <td class="gb-col-status">${status}</td>
  </tr>`;
}

function renderCourseCard(card: CourseCardModel): Html {
  const { course, assignments } = card;
  const missingBadge =
    course.missingCount > 0 ? html`<span class="gb-flag">${course.missingCount} missing</span>` : null;
  const meta = [
    course.teacher,
    assignments.length === 1 ? '1 assignment' : `${assignments.length} assignments`,
  ].filter(Boolean);
  // Every course stays open: this page is the big-picture view, and a parent
  // should not have to click through seven cards to see the term.
  return html`<section class="gb-course" aria-label="${course.title}">
    <div class="gb-course-head">
      <span class="gb-course-id">
        <span class="gb-course-title">${course.title}</span>
        <span class="gb-course-meta">${meta.join(' · ')}</span>
      </span>
      <span class="gb-course-tags">${missingBadge}${renderGrade(course)}</span>
    </div>
    ${assignments.length > 0
      ? html`<div class="gb-table-wrap">
        <table class="gb-table gb-table--assignments">
          <thead><tr>
            <th scope="col">Assignment</th>
            <th scope="col" class="gb-col-due">Due</th>
            <th scope="col" class="gb-col-cat">Category</th>
            <th scope="col" class="gb-num gb-col-score">Score</th>
            <th scope="col" class="gb-col-status">Status</th>
          </tr></thead>
          <tbody>${assignments.map(renderAssignmentRow)}</tbody>
        </table>
      </div>`
      : html`<p class="gb-empty">No assignments recorded.</p>`}
  </section>`;
}

function renderMissingTable(missing: MissingAssignment[]): Html {
  if (missing.length === 0) {
    return html`<div class="gb-panel"><p class="gb-note">Nothing missing. 🎉</p></div>`;
  }
  return html`<div class="gb-panel"><div class="gb-table-wrap">
    <table class="gb-table">
      <thead><tr>
        <th scope="col">Assignment</th>
        <th scope="col">Course</th>
        <th scope="col">Student</th>
        <th scope="col">Due</th>
        <th scope="col" class="gb-col-cat">Category</th>
      </tr></thead>
      <tbody>
        ${missing.map(
          (a) => html`<tr data-flag="true">
            <td class="gb-title-cell">${a.title}</td>
            <td>${a.courseTitle}</td>
            <td>${a.studentName}</td>
            <td>${renderDate(a.dueDate)}</td>
            <td class="gb-cat gb-col-cat">${a.category ?? html`<span class="gb-dash">—</span>`}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div></div>`;
}

export function renderDashboardPage(model: DashboardPageModel): Html {
  const heading = model.activeStudent ? `${model.activeStudent.name}'s gradebook` : 'Gradebook';
  // The date range is shown because it is *why* this term is the default: the
  // dashboard opens on whichever period the district says today falls inside.
  const termRange = model.activeTerm?.periodStart
    ? ` · ${model.activeTerm.periodStart} → ${model.activeTerm.periodEnd ?? '?'}`
    : '';
  const subtitle = model.activeTerm
    ? html`<p class="gb-subtitle">${termLabel(model.activeTerm)}${termRange}</p>`
    : null;

  return html`<main class="gb">
    <div class="gb-head">
      <div>
        <h1>${model.activeStudent ? model.activeStudent.name : 'Gradebook'}</h1>
        ${subtitle}
      </div>
      <form method="post" action="/gradebook/sync">
        <button type="submit"${model.configured ? null : html` disabled`}>Sync now</button>
      </form>
    </div>
    ${model.banner ? html`<p class="banner">${model.banner}</p>` : null}
    ${!model.configured ? html`<p class="banner">ParentVUE is not configured — set GRADEBOOK_PARENTVUE_HOST, GRADEBOOK_PARENTVUE_USER, and GRADEBOOK_PARENTVUE_PASS on the server, then sync.</p>` : null}
    ${model.students.length === 0
      ? html`<div class="gb-panel"><p class="gb-note">No students on file yet.${model.configured ? ' Press “Sync now” to pull ParentVUE.' : ''}</p></div>`
      : html`
        <div class="gb-toolbar">
          ${renderStudentTabs(model)}
          ${renderTermPicker(model)}
          ${renderViewTabs(model)}
        </div>
        ${model.view === 'missing'
          ? renderMissingTable(model.missing)
          : model.cards.length > 0
            ? html`<section class="gb-courses" aria-label="Courses">${model.cards.map(renderCourseCard)}</section>`
            : html`<div class="gb-panel"><p class="gb-note">No courses this term.</p></div>`}
      `}
    <div class="gb-foot">
      <p>${model.lastSyncAt ? html`Last synced ${model.lastSyncAt}` : 'Never synced.'}</p>
      <p>${heading} · read-only snapshot of ParentVUE</p>
    </div>
  </main>`;
}

export function renderErrorPage(model: ErrorPageModel): Html {
  return html`<main>
    <h1>${model.title}</h1>
    <p>${model.message}</p>
    <p><a href="/gradebook">Back to the gradebook</a></p>
  </main>`;
}
