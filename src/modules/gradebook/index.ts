import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { withAudit } from '../../audit.js';
import type { Config } from '../../config.js';
import { migrate, openDatabase } from '../../storage/sqlite.js';
import type { HomeModule, ModuleContext, UiContext } from '../types.js';
import { textResult } from '../util.js';
import { GradebookError } from './errors.js';
import {
  renderAssignments,
  renderCourses,
  renderMissing,
  renderOverview,
  renderStatus,
  renderSyncSummary,
  renderTerms,
  renderTrend,
  termLabel,
  type OverviewStudent,
} from './logic.js';
import { MIGRATIONS } from './migrations.js';
import { assignmentStatusFilter, courseRef, studentRef, termRef, type SyncTrigger } from './schema.js';
import { GradebookStore } from './store.js';
import { createSyncClient, createSyncGate, runSync } from './sync.js';
import { createGradebookUiRouter } from './ui/router.js';

const INSTRUCTIONS =
  'Students are addressed by name (case-insensitive) or stu_ id; courses by crs_ id — use gradebook_overview to find them. ' +
  'Data is a nightly ParentVUE snapshot: call gradebook_sync first if freshness matters. ' +
  'gradebook_overview includes what\'s new for each student. ' +
  'gradebook_missing is the first place to look for action items: the consolidated missing-work view ParentVUE lacks. ' +
  'This module is read-only upstream; it never writes back to the school district.';

const HOUR_MS = 3_600_000;
/** setTimeout coerces delays above this to 1ms, which would spin the scheduler. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/**
 * Minimum gap between syncs started from the unauthenticated dashboard.
 * Every press is a real ParentVUE login; without this, anyone who can reach
 * the UI port can hammer the district and trip an account lockout.
 */
const DASHBOARD_SYNC_COOLDOWN_MS = 60_000;

export function createGradebookModule(config: Config, logger: Logger): HomeModule {
  const db = openDatabase(config.gradebook.dbPath);
  try {
    migrate(db, MIGRATIONS);
  } catch (err) {
    db.close();
    throw err;
  }
  const store = new GradebookStore(db);
  const gb = config.gradebook;
  const syncClient = createSyncClient(config);

  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  let schedulerArmed = false;

  async function syncOnce(trigger: SyncTrigger): Promise<void> {
    if (!syncClient) {
      const now = new Date();
      const runId = store.beginSyncRun(now.toISOString(), trigger);
      store.finishSyncRun(
        runId,
        'not_configured',
        {
          errors: [
            'ParentVUE is not configured; set GRADEBOOK_PARENTVUE_HOST, GRADEBOOK_PARENTVUE_USER, and GRADEBOOK_PARENTVUE_PASS.',
          ],
        },
        now,
      );
      return;
    }
    await runSync({ client: syncClient, store, trigger, studentAllowlist: gb.students });
  }

  const requestSync = createSyncGate(syncOnce, { cooldownMs: DASHBOARD_SYNC_COOLDOWN_MS });

  // In-process scheduler: the container is long-lived, so a timer avoids
  // depending on an external cron plus an MCP client to invoke the tool.
  // The scheduler only runs when GRADEBOOK_SYNC_ENABLED=true is set in .env
  // (default off): some districts' ParentVUE terms prohibit automatic login, so the
  // on/off switch is an explicit opt-in. gradebook_sync remains the manual
  // "sync now" path, and GRADEBOOK_SYNC_INTERVAL_HOURS=0 also disables the
  // timer.
  // Whether the scheduler armed is stated at startup either way. Without this the
  // only way to tell an armed timer from a silently skipped one was to wait out the
  // first delay and look for a row in sync_runs.
  if (!syncClient) {
    logger.warn(
      { module: 'gradebook' },
      'gradebook automatic sync is OFF: ParentVUE is not configured (GRADEBOOK_PARENTVUE_HOST / GRADEBOOK_PARENTVUE_USER / GRADEBOOK_PARENTVUE_PASS)',
    );
  } else if (!gb.syncEnabled) {
    logger.info(
      { module: 'gradebook' },
      'gradebook automatic sync is OFF: GRADEBOOK_SYNC_ENABLED is not true',
    );
  } else if (gb.syncIntervalHours <= 0) {
    logger.info(
      { module: 'gradebook' },
      'gradebook automatic sync is OFF: GRADEBOOK_SYNC_INTERVAL_HOURS is 0',
    );
  } else {
    const intervalMs = Math.min(gb.syncIntervalHours * HOUR_MS, MAX_TIMEOUT_MS);
    const firstDelayMs = (2 + Math.random() * 5) * 60_000; // 2–7 minutes after startup
    const tick = (): void => {
      const startedAt = Date.now();
      requestSync({ trigger: 'scheduled' })
        .then((outcome) => {
          const run = store.lastSyncRun();
          logger.info(
            {
              module: 'gradebook',
              outcome,
              runId: run?.id,
              status: run?.status,
              durationMs: Date.now() - startedAt,
            },
            'gradebook scheduled sync finished',
          );
        })
        .catch((err: unknown) => {
          // runSync records failures in sync_runs too; this makes them visible in
          // the log, where an operator is actually looking.
          logger.error({ module: 'gradebook', err }, 'gradebook scheduled sync threw');
        })
        .finally(() => {
          if (!disposed) {
            timer = setTimeout(tick, intervalMs);
            timer.unref?.();
          }
        });
    };
    timer = setTimeout(tick, firstDelayMs);
    timer.unref?.();
    schedulerArmed = true;
    logger.info(
      {
        module: 'gradebook',
        firstSyncInSeconds: Math.round(firstDelayMs / 1000),
        intervalHours: gb.syncIntervalHours,
      },
      'gradebook automatic sync is ON: scheduler armed',
    );
  }

  return {
    name: 'gradebook',
    instructions: INSTRUCTIONS,
    register(server: McpServer, ctx: ModuleContext) {
      server.registerTool(
        'gradebook_overview',
        {
          title: 'Gradebook overview',
          description: 'Every student, their current term, per-course grades with missing counts, and what\'s new: new assignments, scores, and missing work in the 24 hours before the latest change. Start here for "anything new?"',
          inputSchema: {},
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        withAudit(ctx.logger, ctx.identity, 'gradebook_overview', () => {
          const students: OverviewStudent[] = store.listStudents().map((student) => {
            const term = store.latestTerm(student.id);
            return { student, term, courses: term ? store.courses(term.id) : [], whatsNew: store.whatsNew(student.id) };
          });
          return textResult({ students }, renderOverview(students, config.tz));
        }),
      );

      server.registerTool(
        'gradebook_terms',
        {
          title: 'Gradebook terms',
          description: 'All school years and reporting periods on file for a student.',
          inputSchema: { student: studentRef },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        withAudit(ctx.logger, ctx.identity, 'gradebook_terms', ({ student }) => {
          const resolved = store.resolveStudent(student);
          const terms = store.terms(resolved.id);
          return textResult({ student: resolved, terms }, renderTerms(resolved, terms));
        }),
      );

      server.registerTool(
        'gradebook_courses',
        {
          title: 'Gradebook courses',
          description: 'Courses for a student’s term with teacher, grade, and missing count. Defaults to the latest term.',
          inputSchema: {
            student: studentRef,
            schoolYear: termRef.shape.schoolYear,
            reportingPeriod: termRef.shape.reportingPeriod,
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        withAudit(ctx.logger, ctx.identity, 'gradebook_courses', ({ student, schoolYear, reportingPeriod }) => {
          const resolved = store.resolveStudent(student);
          const term = store.resolveTerm(resolved.id, schoolYear, reportingPeriod);
          const courses = store.courses(term.id);
          return textResult(
            { student: resolved, term, courses },
            renderCourses(resolved, term, courses),
          );
        }),
      );

      server.registerTool(
        'gradebook_assignments',
        {
          title: 'Gradebook assignments',
          description: 'A course\'s assignments for the whole school year, newest first, with due date, category, score, and status. Rows flag new work; a score that changed carries its history.',
          inputSchema: {
            course: courseRef,
            status: assignmentStatusFilter.default('missing'),
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        withAudit(ctx.logger, ctx.identity, 'gradebook_assignments', ({ course, status }) => {
          const { course: resolved, term, student } = store.resolveCourse(course);
          const news = store.whatsNew(student.id).items;
          const newIds = new Set(news.map((item) => item.assignment.id));
          const newlyMissingIds = new Set(news.filter((item) => item.kind === 'now_missing').map((item) => item.assignment.id));
          const assignments = store.assignments(resolved.id, status).map((assignment) => ({
            ...assignment,
            new: newIds.has(assignment.id),
          }));
          return textResult(
            { student, term: termLabel(term), course: resolved, status, assignments },
            renderAssignments(resolved, assignments, status, newlyMissingIds),
          );
        }),
      );

      server.registerTool(
        'gradebook_missing',
        {
          title: 'Missing work',
          description: 'Consolidated missing/incomplete/late work across all courses — the view ParentVUE lacks; rows flag work that newly went missing. Omit student for all students.',
          inputSchema: {
            student: studentRef.optional(),
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        withAudit(ctx.logger, ctx.identity, 'gradebook_missing', ({ student }) => {
          const resolved = student === undefined ? undefined : store.resolveStudent(student);
          const newsByStudent = new Map(
            (resolved ? [resolved] : store.listStudents()).map((entry) => [entry.id, store.whatsNew(entry.id).items]),
          );
          const newlyMissingIds = new Set([...newsByStudent.values()].flat()
            .filter((item) => item.kind === 'now_missing').map((item) => item.assignment.id));
          const newIds = new Set([...newsByStudent.values()].flat().map((item) => item.assignment.id));
          const items = store.missing(resolved?.id).map((item) => ({ ...item, new: newIds.has(item.id) }));
          const scope = resolved ? resolved.name : 'all students';
          return textResult({ student: resolved ?? null, items }, renderMissing(items, scope, newlyMissingIds));
        }),
      );

      server.registerTool(
        'gradebook_trend',
        {
          title: 'Grade trend',
          description: 'Grade history for a course in its current reporting period.',
          inputSchema: { course: courseRef },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        withAudit(ctx.logger, ctx.identity, 'gradebook_trend', ({ course }) => {
          const { course: resolved } = store.resolveCourse(course);
          const points = store.trend(resolved.id);
          return textResult({ course: resolved, points }, renderTrend(resolved, points));
        }),
      );

      server.registerTool(
        'gradebook_sync',
        {
          title: 'Sync gradebook now',
          description: 'Pull ParentVUE now and merge into the local gradebook. Idempotent; safe to call anytime.',
          inputSchema: {},
          annotations: { readOnlyHint: false, openWorldHint: true },
        },
        withAudit(ctx.logger, ctx.identity, 'gradebook_sync', async () => {
          await requestSync({ trigger: 'mcp' });
          const run = store.lastSyncRun();
          if (!run) throw new GradebookError('store_error', 'Sync ran but no summary was recorded.');
          return textResult({ run }, renderSyncSummary(run));
        }),
      );

      server.registerTool(
        'gradebook_status',
        {
          title: 'Gradebook status',
          description: 'Last sync outcome, whether ParentVUE is configured, whether the automatic scheduler is armed, when it last fired, and row counts.',
          inputSchema: {},
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        withAudit(ctx.logger, ctx.identity, 'gradebook_status', () => {
          const counts = store.counts();
          const status = {
            configured: syncClient !== null,
            schedulerArmed,
            lastRun: store.lastSyncRun(),
            lastScheduledRun: store.lastSyncRunBy('scheduled'),
            counts,
          };
          return textResult(status, renderStatus(status));
        }),
      );
    },
    createUiRouter(ctx: UiContext) {
      return createGradebookUiRouter(store, ctx, {
        configured: syncClient !== null,
        onSyncNow: () => requestSync({ cooldown: true, trigger: 'dashboard' }),
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      db.close();
    },
  };
}
