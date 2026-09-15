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
    store.upsertCourse({ termId: q1, title: 'Science Now', gradeLetter: 'A', gradeScore: 3.8 }, NOW);
    store.upsertCourse({ termId: sem2, title: 'Science Later' }, NOW);
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
});
