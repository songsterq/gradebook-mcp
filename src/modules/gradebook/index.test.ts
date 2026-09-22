import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pino from 'pino';
import { expect, it } from 'vitest';
import type { Config } from '../../config.js';
import { migrate, openDatabase } from '../../storage/sqlite.js';
import { createGradebookModule } from './index.js';
import { MIGRATIONS } from './migrations.js';
import { GradebookStore } from './store.js';

it('includes whatsNew in overview JSON and new on assignment rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-mcp-gradebook-new-'));
  const dbPath = join(dir, 'gradebook.sqlite');
  const db = openDatabase(dbPath);
  migrate(db, MIGRATIONS);
  const store = new GradebookStore(db);
  const bootstrap = '2026-09-20T00:00:00.000Z';
  const arrival = '2026-09-21T00:00:00.000Z';
  const studentId = store.upsertStudent({ parentvueId: 'p', name: 'Aiden', school: 'Odle' }, bootstrap).id;
  const termId = store.upsertTerm({ studentId, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0,
    periodStart: '2026-09-01', periodEnd: '2026-12-01' }, bootstrap).id;
  const courseId = store.upsertCourse({ studentId, schoolYear: '2026-2027', title: 'Science' }, bootstrap).id;
  store.upsertCourseMark({ courseId, termId }, bootstrap);
  store.upsertAssignment({ courseId, extKey: 'old', title: 'Old Lab', status: 'scored' }, bootstrap);
  store.upsertAssignment({ courseId, extKey: 'new', title: 'New Lab', status: 'scored', score: 3, scoreRaw: '3' }, arrival);
  db.close();

  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    ui: { port: undefined, host: '127.0.0.1' },
    nodeEnv: 'test',
    logLevel: 'silent',
    tz: 'America/Los_Angeles',
    dataDir: dir,
    modules: ['gradebook'],
    access: { teamDomain: undefined, aud: undefined, allowedEmails: [], allowedServiceTokens: [] },
    chores: { baseUrl: undefined },
    lists: { dbPath: join(dir, 'lists.sqlite') },
    gradebook: { dbPath, parentvueUser: undefined, parentvuePass: undefined, syncEnabled: false,
      syncIntervalHours: 24, students: [], parentvueHost: 'example.invalid' },
    devInsecureNoAuth: true,
  };
  const logger = pino({ level: 'silent' });
  const mod = createGradebookModule(config, logger);
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; content: unknown[] }>>();
  const server = { registerTool(name: string, _options: unknown, handler: (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; content: unknown[] }>) {
    handlers.set(name, handler);
  } } as unknown as McpServer;
  try {
    mod.register(server, { config, logger, identity: { kind: 'dev-insecure' } });
    expect(mod.instructions).toContain("gradebook_overview includes what's new");
    const overview = await handlers.get('gradebook_overview')!({});
    const students = overview.structuredContent?.['students'] as Array<{ whatsNew: { items: Array<{ kind: string }> } }>;
    expect(students[0]?.whatsNew.items.map((item) => item.kind)).toEqual(['new_assignment']);
    expect(overview.content).toEqual([{ type: 'text', text: expect.stringContaining("What's new since") }]);

    const assignments = await handlers.get('gradebook_assignments')!({ course: courseId, status: 'all' });
    const rows = assignments.structuredContent?.['assignments'] as Array<{ title: string; new: boolean }>;
    expect(rows.map((row) => [row.title, row.new])).toEqual([['New Lab', true], ['Old Lab', false]]);
    expect(assignments.content).toEqual([{ type: 'text', text: expect.stringContaining('New Lab: 3 · Scored · new') }]);
  } finally {
    mod.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
