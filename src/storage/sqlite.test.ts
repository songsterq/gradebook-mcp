import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isUniqueViolation, migrate, openDatabase, withTransaction } from './sqlite.js';

function pragma(db: DatabaseSync, name: string): unknown {
  return Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
}

describe('openDatabase', () => {
  it('creates the parent directory and applies the connection pragmas', () => {
    const root = mkdtempSync(join(tmpdir(), 'gradebook-mcp-sqlite-'));
    const path = join(root, 'nested', 'gradebook.sqlite');
    const db = openDatabase(path);

    try {
      expect(existsSync(path)).toBe(true);
      expect(pragma(db, 'journal_mode')).toBe('wal');
      expect(pragma(db, 'synchronous')).toBe(1);
      expect(pragma(db, 'busy_timeout')).toBe(5000);
      expect(pragma(db, 'foreign_keys')).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('migrate', () => {
  it('runs pending migrations in version order and is idempotent', () => {
    const db = openDatabase(':memory:');
    const applied: number[] = [];
    const migrations = [
      {
        version: 2,
        up(database: DatabaseSync) {
          applied.push(2);
          database.exec('ALTER TABLE example ADD COLUMN name TEXT');
        },
      },
      {
        version: 1,
        up(database: DatabaseSync) {
          applied.push(1);
          database.exec('CREATE TABLE example (id INTEGER PRIMARY KEY)');
        },
      },
    ] as const;

    try {
      migrate(db, migrations);
      expect(applied).toEqual([1, 2]);
      expect(pragma(db, 'user_version')).toBe(2);

      migrate(db, migrations);
      expect(applied).toEqual([1, 2]);
      expect(pragma(db, 'user_version')).toBe(2);
    } finally {
      db.close();
    }
  });

  it('rolls back a throwing migration and leaves user_version unchanged', () => {
    const db = openDatabase(':memory:');
    const first = {
      version: 1,
      up(database: DatabaseSync) {
        database.exec('CREATE TABLE stable (id INTEGER PRIMARY KEY)');
      },
    };
    const failing = {
      version: 2,
      up(database: DatabaseSync) {
        database.exec('CREATE TABLE rolled_back (id INTEGER PRIMARY KEY)');
        throw new Error('migration failed');
      },
    };

    try {
      migrate(db, [first]);
      expect(() => migrate(db, [first, failing])).toThrow('migration failed');
      expect(pragma(db, 'user_version')).toBe(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'rolled_back'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('withTransaction', () => {
  it('commits and returns the callback value', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE entries (value TEXT)');

    try {
      const result = withTransaction(db, () => {
        db.prepare('INSERT INTO entries VALUES (?)').run('saved');
        return 'result';
      });

      expect(result).toBe('result');
      expect(db.prepare('SELECT value FROM entries').get()).toEqual({ value: 'saved' });
    } finally {
      db.close();
    }
  });

  it('rolls back when the callback throws', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE entries (value TEXT)');

    try {
      expect(() =>
        withTransaction(db, () => {
          db.prepare('INSERT INTO entries VALUES (?)').run('discarded');
          throw new Error('write failed');
        }),
      ).toThrow('write failed');
      expect(db.prepare('SELECT value FROM entries').get()).toBeUndefined();
      expect(db.isTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it('passes through an existing transaction without committing it', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE entries (value TEXT); BEGIN');

    try {
      withTransaction(db, () => {
        expect(db.isTransaction).toBe(true);
        db.prepare('INSERT INTO entries VALUES (?)').run('pending');
      });

      expect(db.isTransaction).toBe(true);
      db.exec('ROLLBACK');
      expect(db.prepare('SELECT value FROM entries').get()).toBeUndefined();
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
      db.close();
    }
  });
});

describe('isUniqueViolation', () => {
  it('distinguishes a UNIQUE violation from other SQLite errors', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE entries (value TEXT UNIQUE)');
    db.prepare('INSERT INTO entries VALUES (?)').run('duplicate');

    try {
      let uniqueError: unknown;
      let otherError: unknown;
      try {
        db.prepare('INSERT INTO entries VALUES (?)').run('duplicate');
      } catch (err) {
        uniqueError = err;
      }
      try {
        db.exec('SELECT * FROM missing_table');
      } catch (err) {
        otherError = err;
      }

      expect(isUniqueViolation(uniqueError)).toBe(true);
      expect(isUniqueViolation(otherError)).toBe(false);
      expect(isUniqueViolation(new Error('not SQLite'))).toBe(false);
    } finally {
      db.close();
    }
  });
});
