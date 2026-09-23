import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../config.js';
import { openDatabase, migrate } from '../../storage/sqlite.js';
import { createGradebookModule } from './index.js';
import { MIGRATIONS } from './migrations.js';
import { GradebookStore } from './store.js';

type Line = Record<string, unknown>;

function capturingLogger(lines: Line[]) {
  return pino(
    { level: 'info' },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as Line);
      },
    },
  );
}

describe('gradebook scheduler visibility', () => {
  let tempDir: string;
  let lines: Line[];

  function configWith(overrides: Partial<Config['gradebook']>): Config {
    return {
      port: 0,
      host: '127.0.0.1',
      ui: { port: undefined, host: '127.0.0.1', allowWildcardBind: false },
      nodeEnv: 'test',
      logLevel: 'silent',
      tz: 'America/Los_Angeles',
      dataDir: tempDir,
      mcpBearerToken: undefined,
      access: { teamDomain: undefined, aud: undefined, allowedEmails: [], allowedServiceTokens: [] },
      gradebook: {
        dbPath: join(tempDir, 'gradebook.sqlite'),
        parentvueHost: 'example.invalid',
        parentvueUser: 'u',
        parentvuePass: 'p',
        syncIntervalHours: 24,
        syncEnabled: true,
        students: [],
        ...overrides,
      },
      devInsecureNoAuth: true,
    };
  }

  function messages(): string[] {
    return lines.map((line) => String(line['msg']));
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gradebook-mcp-sched-'));
    lines = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('says so, with the delay and interval, when the scheduler arms', () => {
    const mod = createGradebookModule(configWith({}), capturingLogger(lines));
    try {
      const armed = lines.find((l) => String(l['msg']).includes('scheduler armed'));
      expect(armed).toBeDefined();
      expect(armed?.['intervalHours']).toBe(24);
      // The first fire is jittered 2-7 minutes out.
      expect(armed?.['firstSyncInSeconds']).toBeGreaterThanOrEqual(120);
      expect(armed?.['firstSyncInSeconds']).toBeLessThanOrEqual(420);
    } finally {
      mod.dispose?.();
    }
  });

  it('names missing credentials as the reason it is off', () => {
    const config = configWith({ parentvueUser: undefined, parentvuePass: undefined });
    const mod = createGradebookModule(config, capturingLogger(lines));
    try {
      expect(messages().some((m) => m.includes('ParentVUE is not configured'))).toBe(true);
      expect(messages().some((m) => m.includes('scheduler armed'))).toBe(false);
    } finally {
      mod.dispose?.();
    }
  });

  it('names GRADEBOOK_SYNC_ENABLED as the reason it is off', () => {
    const mod = createGradebookModule(configWith({ syncEnabled: false }), capturingLogger(lines));
    try {
      expect(messages().some((m) => m.includes('GRADEBOOK_SYNC_ENABLED is not true'))).toBe(true);
      expect(messages().some((m) => m.includes('scheduler armed'))).toBe(false);
    } finally {
      mod.dispose?.();
    }
  });

  it('names a zero interval as the reason it is off', () => {
    const mod = createGradebookModule(configWith({ syncIntervalHours: 0 }), capturingLogger(lines));
    try {
      expect(messages().some((m) => m.includes('GRADEBOOK_SYNC_INTERVAL_HOURS is 0'))).toBe(true);
      expect(messages().some((m) => m.includes('scheduler armed'))).toBe(false);
    } finally {
      mod.dispose?.();
    }
  });
});

describe('sync run provenance', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gradebook-mcp-trigger-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records and reads back what started each run', () => {
    const db = openDatabase(join(tempDir, 'gb.sqlite'));
    migrate(db, MIGRATIONS);
    const store = new GradebookStore(db);

    store.finishSyncRun(store.beginSyncRun('2026-09-14T01:00:00.000Z', 'scheduled'), 'ok', {});
    store.finishSyncRun(store.beginSyncRun('2026-09-14T02:00:00.000Z', 'dashboard'), 'ok', {});

    expect(store.lastSyncRun()?.trigger).toBe('dashboard');
    // A later manual sync must not hide whether the scheduler ever fired.
    expect(store.lastSyncRunBy('scheduled')?.startedAt).toBe('2026-09-14T01:00:00.000Z');
    expect(store.lastSyncRunBy('mcp')).toBeNull();
    db.close();
  });

  it('backfills rows written before the column existed', () => {
    const db = openDatabase(join(tempDir, 'old.sqlite'));
    // Migrate only as far as v2, the schema that had no provenance column.
    migrate(db, MIGRATIONS.filter((m) => m.version <= 2));
    db.prepare(
      `INSERT INTO sync_runs (started_at, finished_at, status, detail) VALUES (?, ?, 'ok', '{}')`,
    ).run('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z');

    migrate(db, MIGRATIONS);

    const store = new GradebookStore(db);
    expect(store.lastSyncRun()?.trigger).toBe('unknown');
    expect(store.lastSyncRunBy('scheduled')).toBeNull();
    db.close();
  });

  it('rejects a trigger the schema does not allow', () => {
    const db = openDatabase(join(tempDir, 'bad.sqlite'));
    migrate(db, MIGRATIONS);
    const store = new GradebookStore(db);
    // @ts-expect-error -- the CHECK constraint is the runtime backstop for the type.
    expect(() => store.beginSyncRun('2026-09-14T00:00:00.000Z', 'cron')).toThrow();
    db.close();
  });
});
