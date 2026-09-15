import { Router } from 'express';
import type { Request, Response } from 'express';
import type { UiContext } from '../../types.js';
import { renderDocument } from '../../../ui/layout.js';
import { GradebookError } from '../errors.js';
import type { SyncOutcome } from '../sync.js';
import type { Student, Term } from '../schema.js';
import type { GradebookStore } from '../store.js';
import { GRADEBOOK_STYLES } from './styles.js';
import { renderDashboardPage, renderErrorPage } from './views.js';
import type { CourseCardModel } from './views.js';

export interface GradebookUiOptions {
  configured: boolean;
  onSyncNow: () => Promise<SyncOutcome>;
  /** Injectable clock for tests; defaults to the real date. */
  today?: () => string;
}

function queryField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonce(res: Response): string {
  return typeof res.locals.nonce === 'string' ? res.locals.nonce : '';
}

function sendErrorPage(res: Response, status: number, title: string, message: string): void {
  const body = renderErrorPage({ title, message });
  res
    .status(status)
    .set('Content-Type', 'text/html; charset=utf-8')
    .send(renderDocument({ title, nonce: nonce(res), body, styles: GRADEBOOK_STYLES }));
}

function pickStudent(store: GradebookStore, ref: string | undefined): Student | null {
  const students = store.listStudents();
  if (students.length === 0) return null;
  if (ref === undefined) return students[0] ?? null;
  try {
    return store.resolveStudent(ref);
  } catch {
    return students[0] ?? null;
  }
}

/**
 * The picker's own selection wins; otherwise fall back to the term the student
 * is actually in today. That default comes from `latestTerm`, which reads the
 * district's published reporting-period dates — landing on the newest term in
 * the list instead would open the dashboard on a period that has not started,
 * whose courses are all unscored.
 */
function pickTerm(
  store: GradebookStore,
  student: Student,
  ref: string | undefined,
  todayYmd: string,
): Term | null {
  if (ref !== undefined) {
    const match = store.terms(student.id).find((t) => t.id === ref);
    if (match) return match;
  }
  return store.latestTerm(student.id, todayYmd);
}

export function createGradebookUiRouter(
  store: GradebookStore,
  ctx: UiContext,
  options: GradebookUiOptions,
): Router {
  const router = Router();
  const today = options.today ?? ((): string => new Date().toISOString().slice(0, 10));

  router.get('/', (req: Request, res: Response) => {
    try {
      const view = queryField(req.query.view) === 'missing' ? 'missing' : 'courses';
      const banner = queryField(req.query.banner);
      const student = pickStudent(store, queryField(req.query.student));
      const term = student ? pickTerm(store, student, queryField(req.query.term), today()) : null;
      const terms = student ? store.terms(student.id) : [];
      const cards: CourseCardModel[] =
        term && view === 'courses'
          ? store.courses(term.id).map((course) => ({
              course,
              assignments: store.assignments(course.id, 'all'),
            }))
          : [];
      // Scoped to the term the picker is showing, so the badge and the table
      // agree with the courses on screen.
      const missing = student && term ? store.missing(student.id, term.id) : [];
      const lastRun = store.lastSyncRun();

      const body = renderDashboardPage({
        students: store.listStudents(),
        activeStudent: student,
        terms,
        activeTerm: term,
        cards,
        missing,
        view,
        configured: options.configured,
        lastSyncAt: lastRun?.startedAt ?? null,
        banner,
      });
      res
        .status(200)
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(renderDocument({ title: 'Gradebook', nonce: nonce(res), body, styles: GRADEBOOK_STYLES }));
    } catch (err) {
      ctx.logger.error({ err }, 'gradebook dashboard request failed');
      sendErrorPage(res, 500, 'Something went wrong', 'The dashboard could not complete that request.');
    }
  });

  router.post('/sync', (_req: Request, res: Response) => {
    options
      .onSyncNow()
      .then((outcome) => {
        const run = store.lastSyncRun();
        const banner =
          outcome === 'cooldown'
            ? 'Synced moments ago — try again in a minute.'
            : run && run.status === 'ok'
              ? 'Synced just now.'
              : run
                ? `Sync finished with status: ${run.status}.`
                : 'Sync requested.';
        res.redirect(303, `/gradebook?banner=${encodeURIComponent(banner)}`);
      })
      .catch((err: unknown) => {
        ctx.logger.error({ err }, 'gradebook dashboard sync failed');
        const message =
          err instanceof GradebookError ? err.message : 'The sync could not complete.';
        res.redirect(303, `/gradebook?banner=${encodeURIComponent(`Sync failed: ${message}`)}`);
      });
  });

  router.use((_req: Request, res: Response) => {
    sendErrorPage(res, 404, 'Not found', 'That gradebook page does not exist.');
  });

  return router;
}
