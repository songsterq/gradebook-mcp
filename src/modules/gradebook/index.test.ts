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
  const dir = mkdtempSync(join(tmpdir(), 'gradebook-mcp-new-'));
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
    ui: { port: undefined, host: '127.0.0.1', allowWildcardBind: false },
    nodeEnv: 'test',
    logLevel: 'silent',
    tz: 'America/Los_Angeles',
    dataDir: dir,
    mcpBearerToken: undefined,
    access: { teamDomain: undefined, aud: undefined, allowedEmails: [], allowedServiceTokens: [] },
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

it('flags newly missing work in all three tool outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gradebook-mcp-missing-'));
  const dbPath = join(dir, 'gradebook.sqlite');
  const db = openDatabase(dbPath);
  migrate(db, MIGRATIONS);
  const store = new GradebookStore(db);
  const first = '2026-09-20T00:00:00.000Z';
  const later = '2026-09-21T00:00:00.000Z';
  const studentId = store.upsertStudent({ parentvueId: 'p', name: 'Aiden', school: 'Odle' }, first).id;
  const termId = store.upsertTerm({ studentId, schoolYear: '2026-2027', reportingPeriod: 'Q1', periodIndex: 0,
    periodStart: '2026-09-01', periodEnd: '2026-12-01' }, first).id;
  const courseId = store.upsertCourse({ studentId, schoolYear: '2026-2027', title: 'Science' }, first).id;
  store.upsertCourseMark({ courseId, termId }, first);
  const old = store.upsertAssignment({ courseId, extKey: 'old', title: 'Old Missing', status: 'missing' }, first);
  const changed = store.upsertAssignment({ courseId, extKey: 'changed', title: 'Changed Lab', status: 'scored' }, first);
  store.upsertAssignment({ courseId, extKey: 'changed', title: 'Changed Lab', status: 'missing' }, later);
  const fresh = store.upsertAssignment({ courseId, extKey: 'fresh', title: 'Fresh Missing', status: 'missing' }, later);
  store.replaceTermMemberships(termId, studentId, new Set([old.id, changed.id, fresh.id]));
  db.close();

  const config: Config = {
    port: 0, host: '127.0.0.1', ui: { port: undefined, host: '127.0.0.1', allowWildcardBind: false },
    nodeEnv: 'test', logLevel: 'silent', tz: 'America/Los_Angeles', dataDir: dir,
    mcpBearerToken: undefined,
    access: { teamDomain: undefined, aud: undefined, allowedEmails: [], allowedServiceTokens: [] },
    gradebook: { dbPath, parentvueUser: undefined, parentvuePass: undefined, syncEnabled: false,
      syncIntervalHours: 24, students: [], parentvueHost: 'example.invalid' },
    devInsecureNoAuth: true,
  };
  const logger = pino({ level: 'silent' });
  const mod = createGradebookModule(config, logger);
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; content: Array<{ type: string; text: string }> }>>();
  const server = { registerTool(name: string, _options: unknown, handler: (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown>; content: Array<{ type: string; text: string }> }>) {
    handlers.set(name, handler);
  } } as unknown as McpServer;
  try {
    mod.register(server, { config, logger, identity: { kind: 'dev-insecure' } });
    const overview = await handlers.get('gradebook_overview')!({});
    expect(overview.content[0]?.text).toContain('- ⚠️ Changed Lab (Science) · marked missing');
    expect(overview.content[0]?.text).not.toContain('⚠️ Fresh Missing');
    const assignments = await handlers.get('gradebook_assignments')!({ course: courseId, status: 'all' });
    expect(assignments.content[0]?.text).toContain('- ⚠️ Changed Lab:');
    expect(assignments.content[0]?.text).not.toContain('⚠️ Fresh Missing');
    const missing = await handlers.get('gradebook_missing')!({ student: studentId });
    const rows = missing.structuredContent?.['items'] as Array<{ title: string; new: boolean }>;
    expect(new Map(rows.map((row) => [row.title, row.new]))).toEqual(new Map([
      ['Old Missing', false], ['Changed Lab', true], ['Fresh Missing', true],
    ]));
    expect(missing.content[0]?.text).toContain('- ⚠️ **Changed Lab**');
    expect(missing.content[0]?.text).toContain('Changed Lab** (Science, Aiden) · no due date · no category · new');
    expect(missing.content[0]?.text).not.toContain('⚠️ **Fresh Missing**');
  } finally {
    mod.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
