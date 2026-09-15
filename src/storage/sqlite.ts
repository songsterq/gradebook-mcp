import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Migration = {
  version: number;
  up: (db: DatabaseSync) => void;
};

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
  `);
  return db;
}

export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  let currentVersion = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
  );
  const ordered = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new RangeError(`invalid migration version ${migration.version}`);
    }
    if (migration.version <= currentVersion) continue;

    // IMMEDIATE so a concurrent reader (e.g. a backup) makes this wait on the
    // busy timeout rather than failing partway through with SQLITE_BUSY.
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version=${migration.version}`);
      db.exec('COMMIT');
      currentVersion = migration.version;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const sqliteError = err as { code?: unknown; errcode?: unknown };
  return sqliteError.code === 'ERR_SQLITE_ERROR' && sqliteError.errcode === 2067;
}
