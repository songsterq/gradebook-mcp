import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Express } from 'express';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { MIGRATIONS } from '../src/modules/gradebook/migrations.js';
import { GradebookStore } from '../src/modules/gradebook/store.js';
import { createGradebookUiRouter } from '../src/modules/gradebook/ui/router.js';
import type { UiContext } from '../src/modules/types.js';
import { migrate, openDatabase } from '../src/storage/sqlite.js';

function listen(app: Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', (err?: Error) => (err ? reject(err) : resolve(server)));
    server.once('error', reject);
  });
}

const NOW = '2026-09-14T12:00:00.000Z';
const TODAY = '2026-09-14';

describe('gradebook dashboard term default', () => {
  let store: GradebookStore;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    const db = openDatabase(':memory:');
    migrate(db, MIGRATIONS);
    store = new GradebookStore(db);

    const ctx = { config: {} as Config, logger: pino({ level: 'silent' }) } satisfies UiContext;
    const app = express();
    app.use(
      '/gradebook',
      createGradebookUiRouter(store, ctx, {
        configured: true,
        onSyncNow: async () => 'ran',
        today: () => TODAY,
      }),
    );
    server = await listen(app);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  function seed(): { q1: string; sem2: string } {
    const { id: sid } = store.upsertStudent(
      { parentvueId: '1', name: 'Aiden Chien', school: 'Odle' },
      NOW,
    );
    const q1 = store.upsertTerm(
      {
        studentId: sid,
        schoolYear: '2026-2027',
        reportingPeriod: 'Quarter 1',
        periodIndex: 0,
        periodStart: '2026-09-02',
        periodEnd: '2026-11-06',
      },
      NOW,
    ).id;
    const sem2 = store.upsertTerm(
      {
        studentId: sid,
        schoolYear: '2026-2027',
        reportingPeriod: 'Semester 2 Final',
        periodIndex: 3,
        periodStart: '2027-04-06',
        periodEnd: '2027-06-18',
      },
      NOW,
    ).id;
    const current = store.upsertCourse({ studentId: sid, schoolYear: '2026-2027', title: 'Science Now' }, NOW);
    const future = store.upsertCourse({ studentId: sid, schoolYear: '2026-2027', title: 'Science Later' }, NOW);
    store.upsertCourseMark({ courseId: current.id, termId: q1, gradeLetter: 'A', gradeScore: 3.8 }, NOW);
    store.upsertCourseMark({ courseId: future.id, termId: sem2 }, NOW);
    return { q1, sem2 };
  }

  it('opens on the term in progress today, not the last one on the calendar', async () => {
    seed();
    const page = await (await fetch(`${baseUrl}/gradebook`)).text();

    // The picker marks the active term with aria-current; the courses on
    // screen must be the current term's.
    expect(page).toContain('aria-current="page">Quarter 1</span>');
    expect(page).toContain('Science Now');
    expect(page).not.toContain('Science Later');
    expect(page).toContain('2026-09-02 → 2026-11-06');
  });

  it('still honors an explicitly picked term', async () => {
    const { sem2 } = seed();
    const page = await (await fetch(`${baseUrl}/gradebook?term=${sem2}`)).text();

    expect(page).toContain('aria-current="page">Semester 2 Final</span>');
    expect(page).toContain('Science Later');
  });

  it('shows the assignments listed by the selected reporting period', async () => {
    const { id: sid } = store.upsertStudent(
      { parentvueId: '1', name: 'Aiden Chien', school: 'Odle' },
      NOW,
    );
    const q1 = store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Quarter 1',
      periodIndex: 0,
      periodStart: '2026-09-02',
      periodEnd: '2026-11-06',
    }, NOW).id;
    const s1 = store.upsertTerm({
      studentId: sid,
      schoolYear: '2026-2027',
      reportingPeriod: 'Semester 1 Final',
      periodIndex: 1,
      periodStart: '2026-11-09',
      periodEnd: '2027-01-28',
    }, NOW).id;
    const course = store.upsertCourse({ studentId: sid, schoolYear: '2026-2027', title: 'Science' }, NOW);
    store.upsertCourseMark({ courseId: course.id, termId: q1, gradeLetter: 'B' }, NOW);
    store.upsertCourseMark({ courseId: course.id, termId: s1, gradeLetter: 'A' }, NOW);
    const q1Work = store.upsertAssignment({ courseId: course.id, extKey: 'q1', title: 'Quarter Work', status: 'scored' }, NOW);
    const s1Work = store.upsertAssignment({ courseId: course.id, extKey: 's1', title: 'Semester Work', status: 'scored' }, NOW);
    store.replaceTermMemberships(q1, sid, new Set([q1Work.id]));
    store.replaceTermMemberships(s1, sid, new Set([s1Work.id]));
    store.sweepStale(sid);

    const q1Page = await (await fetch(`${baseUrl}/gradebook?term=${q1}`)).text();
    const s1Page = await (await fetch(`${baseUrl}/gradebook?term=${s1}`)).text();
    expect(q1Page).toContain('Quarter Work');
    expect(q1Page).not.toContain('Semester Work');
    expect(s1Page).toContain('Semester Work');
    expect(s1Page).not.toContain('Quarter Work');
  });
});
