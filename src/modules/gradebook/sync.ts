import type { Config } from '../../config.js';
import { ParentVueClient, ParentVueError, parseStudentInfo } from '../../lib/parentvue/src/index.js';
import type {
  AssignmentSnapshot,
  Child,
  GradebookSnapshot,
  StudentInfo,
} from '../../lib/parentvue/src/index.js';
import { GradebookError } from './errors.js';
import type { SyncTrigger } from './schema.js';
import { schoolYearForDate } from './logic.js';
import { fallbackExtKey, GradebookStore } from './store.js';

export interface SyncClientConfig {
  host: string;
  username: string;
  password: string;
  studentAllowlist: string[];
  syncIntervalHours: number;
}

/** Build a ParentVueClient from config, or null when the host or credentials are absent. */
export function createSyncClient(config: Config): ParentVueClient | null {
  const gb = config.gradebook;
  if (!gb.parentvueHost || !gb.parentvueUser || !gb.parentvuePass) return null;
  return new ParentVueClient({
    host: gb.parentvueHost,
    username: gb.parentvueUser,
    password: gb.parentvuePass,
  });
}

/** What a sync request actually did, so callers can say so. */
export type SyncOutcome = 'ran' | 'joined' | 'cooldown';

export interface SyncGateOptions {
  /** Minimum gap between fresh runs for callers that ask to be rate-limited. */
  cooldownMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Serialize sync requests. The scheduler, `gradebook_sync`, and the dashboard
 * button all share one gate: a caller arriving while a run is in flight joins
 * it instead of starting a second one, because overlapping runs race each
 * other's stale-marking and make assignments flap.
 *
 * Callers that pass `cooldown` are additionally refused a *fresh* run within
 * `cooldownMs` of the last one — that is the unauthenticated dashboard button,
 * where every press is a real district login and a lockout risk. The
 * authenticated MCP tool does not opt in.
 */
export function createSyncGate(
  run: (trigger: SyncTrigger) => Promise<void>,
  options: SyncGateOptions,
): (opts: { cooldown?: boolean; trigger: SyncTrigger }) => Promise<SyncOutcome> {
  const clock = options.now ?? Date.now;
  let inFlight: Promise<void> | null = null;
  let lastStartedMs = Number.NEGATIVE_INFINITY;

  return async function requestSync(opts: {
    cooldown?: boolean;
    trigger: SyncTrigger;
  }): Promise<SyncOutcome> {
    const running = inFlight;
    if (running) {
      // A joiner does not get its own row: the run in flight is already recorded
      // against whoever started it, which is the truthful attribution.
      await running;
      return 'joined';
    }
    if (opts.cooldown && clock() - lastStartedMs < options.cooldownMs) {
      return 'cooldown';
    }
    lastStartedMs = clock();
    const started = run(opts.trigger);
    inFlight = started.finally(() => {
      inFlight = null;
    });
    await inFlight;
    return 'ran';
  };
}

export interface StudentSyncResult {
  studentId: string;
  name: string;
  courses: number;
  assignments: number;
  newMissing: number;
  staleMarked: number;
}

export interface RunSyncOptions {
  client: ParentVueClient;
  store: GradebookStore;
  /** What started this run; recorded on the sync_runs row. */
  trigger: SyncTrigger;
  /** Case-insensitive student name allowlist; empty means all children. */
  studentAllowlist?: string[];
  now?: Date;
  todayYmd?: string;
}

interface SnapshotBundle {
  child: Child;
  info: StudentInfo | undefined;
  gradebook: GradebookSnapshot;
}

/**
 * Merge one child's ParentVUE snapshot into the store. Pure apart from the
 * store writes: no network, no clock reads (pass both in) — fully
 * unit-testable with recorded snapshots.
 */
export function diffIntoStore(
  store: GradebookStore,
  bundle: SnapshotBundle,
  nowIso: string,
  todayYmd: string,
): StudentSyncResult {
  const { child, info, gradebook } = bundle;
  const school = info?.schoolName ?? child.schoolName ?? 'Unknown school';
  const gradeLevel = info?.grade ?? child.grade ?? null;

  const { id: studentId } = store.upsertStudent(
    { parentvueId: child.id, name: child.name, school, gradeLevel },
    nowIso,
  );

  // Terms, keyed by the upstream period index — the same value the client
  // stamps on each mark (and sends as `reportPeriod`). It is NOT the array
  // position: districts are free to number periods however they like, and
  // keying on position silently files a mark under the wrong quarter.
  const termIds = new Map<number, string>();
  for (const period of gradebook.reportingPeriods) {
    const schoolYear = schoolYearForDate(period.startDate, new Date(`${todayYmd}T00:00:00Z`));
    const { id } = store.upsertTerm(
      {
        studentId,
        schoolYear,
        reportingPeriod: period.name,
        periodIndex: period.index,
        periodStart: period.startDate,
        periodEnd: period.endDate,
      },
      nowIso,
    );
    termIds.set(period.index, id);
  }

  let courses = 0;
  let assignments = 0;
  let newMissing = 0;
  let staleMarked = 0;
  const completePeriods = new Set(gradebook.completePeriodIndexes ?? []);
  const seenCoursesByTerm = new Map<string, Set<string>>();
  for (const periodIndex of completePeriods) {
    const termId = termIds.get(periodIndex);
    if (termId) seenCoursesByTerm.set(termId, new Set());
  }

  for (const course of gradebook.courses) {
    for (const mark of course.marks) {
      let termId = termIds.get(mark.periodIndex);
      if (!termId) {
        // Defensive: a mark the period list didn't cover gets its own term
        // rather than being dropped.
        const schoolYear = schoolYearForDate(undefined, new Date(`${todayYmd}T00:00:00Z`));
        const reportingPeriod = mark.reportingPeriod?.name ?? `Period ${mark.periodIndex + 1}`;
        termId = store.upsertTerm(
          { studentId, schoolYear, reportingPeriod, periodIndex: mark.periodIndex },
          nowIso,
        ).id;
        termIds.set(mark.periodIndex, termId);
      }
      const upserted = store.upsertCourse(
        {
          termId,
          title: course.title,
          teacher: course.teacher,
          room: course.room,
          period: course.period,
          gradeLetter: mark.letter,
          gradeScore: mark.score,
        },
        nowIso,
      );
      seenCoursesByTerm.get(termId)?.add(course.title);
      if (upserted.gradeChanged) {
        store.appendGradeHistory(
          upserted.id,
          nowIso,
          upserted.gradeChanged.after.letter,
          upserted.gradeChanged.after.score,
        );
      }
      courses += 1;

      const seen = new Set<string>();
      for (const a of mark.assignments) {
        const extKey = a.id !== '' ? a.id : fallbackExtKey(course.title, a.title, a.dueDate ?? null);
        seen.add(extKey);
        const result = store.upsertAssignment(
          {
            courseId: upserted.id,
            extKey,
            title: a.title,
            category: a.category,
            dueDate: a.dueDate,
            pointsPossible: a.pointsPossible,
            score: a.score,
            scoreRaw: a.scoreRaw,
            scoreLetter: a.scoreLetter,
            status: a.status,
            notes: a.notes,
          },
          nowIso,
        );
        assignments += 1;
        if (result.becameActionable) newMissing += 1;
      }
      staleMarked += store.markStaleAssignments(upserted.id, seen);
      store.recomputeMissingCount(upserted.id);
    }
  }

  for (const [termId, seenTitles] of seenCoursesByTerm) {
    staleMarked += store.markStaleCourses(termId, seenTitles);
  }

  return { studentId, name: child.name, courses, assignments, newMissing, staleMarked };
}

/**
 * Full sync: enumerate children, pull each gradebook, merge into the store,
 * and record a sync_runs row. One child's failure doesn't abort the others;
 * the run status reflects that (`partial`).
 */
export async function runSync(options: RunSyncOptions): Promise<{
  runId: number;
  status: 'ok' | 'partial' | 'error' | 'not_configured';
  students: StudentSyncResult[];
  errors: string[];
  durationMs: number;
}> {
  const { client, store } = options;
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const todayYmd = options.todayYmd ?? nowIso.slice(0, 10);
  const allowlist = (options.studentAllowlist ?? []).map((s) => s.toLowerCase());

  const started = Date.now();
  const runId = store.beginSyncRun(nowIso, options.trigger);
  const students: StudentSyncResult[] = [];
  const errors: string[] = [];

  try {
    let children: Child[];
    try {
      children = await client.listChildren();
    } catch (err) {
      throw err instanceof ParentVueError
        ? GradebookError.fromParentVue(err, 'child list')
        : new GradebookError('upstream_error', 'ParentVUE child list failed.', { cause: err });
    }
    const selected = allowlist.length === 0
      ? children
      : children.filter((c) => allowlist.includes(c.name.toLowerCase()));

    for (const child of selected) {
      try {
        // The child-list response already carries school and grade level, so
        // derive the student detail from it rather than spending another API
        // round trip per child on `getStudentInfo`.
        const info = parseStudentInfo(child);
        const gradebook = await client.getGradebook(child.id);
        students.push(diffIntoStore(store, { child, info, gradebook }, nowIso, todayYmd));
      } catch (err) {
        const message =
          err instanceof ParentVueError
            ? `Sync for ${child.name} failed (${err.code}).`
            : `Sync for ${child.name} failed.`;
        errors.push(message);
      }
    }
  } catch (err) {
    const message =
      err instanceof GradebookError ? err.message : 'ParentVUE sync failed before any student completed.';
    errors.push(message);
  }

  const durationMs = Date.now() - started;
  const status = errors.length === 0 ? 'ok' : students.length > 0 ? 'partial' : 'error';
  store.finishSyncRun(
    runId,
    status,
    {
      students: students.map((s) => ({
        name: s.name,
        courses: s.courses,
        assignments: s.assignments,
        newMissing: s.newMissing,
      })),
      errors,
      durationMs,
    },
    new Date(now.getTime() + durationMs),
  );
  return { runId, status, students, errors, durationMs };
}

export type { AssignmentSnapshot, Child, GradebookSnapshot, StudentInfo };
