import type { SQLInputValue } from 'node:sqlite';
import type { Migration } from '../../storage/sqlite.js';
import { newId, scoreKey } from './logic.js';

type Row = Record<string, unknown>;

function sqlValue(value: unknown): SQLInputValue {
  return value as SQLInputValue;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
CREATE TABLE students (
  id            TEXT PRIMARY KEY,
  parentvue_id  TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  school        TEXT NOT NULL,
  grade_level   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
) STRICT;

CREATE TABLE terms (
  id               TEXT PRIMARY KEY,
  student_id       TEXT NOT NULL REFERENCES students(id),
  school_year      TEXT NOT NULL,
  reporting_period TEXT NOT NULL,
  period_index     INTEGER NOT NULL DEFAULT 0,
  period_start     TEXT,
  period_end       TEXT,
  last_synced_at   TEXT,
  UNIQUE (student_id, school_year, reporting_period)
) STRICT;
CREATE INDEX terms_student_year ON terms(student_id, school_year, period_index);

CREATE TABLE courses (
  id             TEXT PRIMARY KEY,
  term_id        TEXT NOT NULL REFERENCES terms(id),
  title          TEXT NOT NULL,
  teacher        TEXT,
  room           TEXT,
  period         TEXT,
  grade_letter   TEXT,
  grade_score    REAL,
  missing_count  INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  UNIQUE (term_id, title)
) STRICT;
CREATE INDEX courses_term ON courses(term_id);

CREATE TABLE assignments (
  id              TEXT PRIMARY KEY,
  course_id       TEXT NOT NULL REFERENCES courses(id),
  ext_key         TEXT NOT NULL,
  title           TEXT NOT NULL,
  category        TEXT,
  due_date        TEXT,
  points_possible REAL,
  score           REAL,
  score_raw       TEXT,
  score_letter    TEXT,
  status          TEXT NOT NULL DEFAULT 'not_due'
                  CHECK (status IN ('missing','late','incomplete','collected',
                                    'not_due','excused','scored')),
  notes           TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  stale           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (course_id, ext_key)
) STRICT;
CREATE INDEX assignments_course_status ON assignments(course_id, status, stale);
CREATE INDEX assignments_status_due ON assignments(status, due_date) WHERE stale = 0;

CREATE TABLE grade_history (
  id           INTEGER PRIMARY KEY,
  course_id    TEXT NOT NULL REFERENCES courses(id),
  observed_at  TEXT NOT NULL,
  grade_letter TEXT,
  grade_score  REAL
) STRICT;
CREATE INDEX grade_history_course ON grade_history(course_id, observed_at);

CREATE TABLE sync_runs (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('ok','partial','error','not_configured')),
  detail      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))
) STRICT;
`);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
ALTER TABLE courses ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
CREATE INDEX courses_term_stale ON courses(term_id, stale);
`);
    },
  },
  {
    version: 3,
    up(db) {
      // Named `triggered_by`, not `trigger`: TRIGGER is a SQLite keyword and would
      // need quoting at every use. Existing rows predate the column and genuinely
      // cannot be attributed, so they backfill to 'unknown' rather than guessing.
      db.exec(`
ALTER TABLE sync_runs ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'unknown'
  CHECK (triggered_by IN ('scheduled','mcp','dashboard','unknown'));
CREATE INDEX sync_runs_triggered_by ON sync_runs(triggered_by, started_at);
`);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
PRAGMA defer_foreign_keys = ON;

CREATE TABLE courses_new (
  id             TEXT PRIMARY KEY,
  student_id     TEXT NOT NULL REFERENCES students(id),
  school_year    TEXT NOT NULL,
  title          TEXT NOT NULL,
  teacher        TEXT,
  room           TEXT,
  period         TEXT,
  last_synced_at TEXT,
  stale          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (student_id, school_year, title)
) STRICT;

CREATE TABLE course_marks (
  id             TEXT PRIMARY KEY,
  course_id      TEXT NOT NULL REFERENCES courses(id),
  term_id        TEXT NOT NULL REFERENCES terms(id),
  grade_letter   TEXT,
  grade_score    REAL,
  missing_count  INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  stale          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (course_id, term_id)
) STRICT;
CREATE INDEX course_marks_term ON course_marks(term_id, stale);

CREATE TABLE assignment_terms (
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  term_id       TEXT NOT NULL REFERENCES terms(id),
  PRIMARY KEY (assignment_id, term_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX assignment_terms_term ON assignment_terms(term_id, assignment_id);

CREATE TABLE grade_history_new (
  id           INTEGER PRIMARY KEY,
  mark_id      TEXT NOT NULL REFERENCES course_marks(id),
  observed_at  TEXT NOT NULL,
  grade_letter TEXT,
  grade_score  REAL
) STRICT;
`);

      const oldCourses = db.prepare(`
        SELECT c.*, t.student_id, t.school_year, t.period_index
        FROM courses c
        JOIN terms t ON t.id = c.term_id
      `).all() as Row[];
      const courseGroups = new Map<string, Row[]>();
      for (const course of oldCourses) {
        const key = JSON.stringify([course['student_id'], course['school_year'], course['title']]);
        const group = courseGroups.get(key) ?? [];
        group.push(course);
        courseGroups.set(key, group);
      }

      const survivorByOldCourse = new Map<string, string>();
      const markByOldCourse = new Map<string, string>();
      const insertCourse = db.prepare(`
        INSERT INTO courses_new
          (id, student_id, school_year, title, teacher, room, period, last_synced_at, stale)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertMark = db.prepare(`
        INSERT INTO course_marks
          (id, course_id, term_id, grade_letter, grade_score, missing_count, last_synced_at, stale)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const group of courseGroups.values()) {
        const byPeriod = [...group].sort(
          (a, b) => Number(a['period_index']) - Number(b['period_index']) || String(a['id']).localeCompare(String(b['id'])),
        );
        const survivor = byPeriod[0]!;
        const survivorId = String(survivor['id']);
        const newest = [...group].sort((a, b) => {
          const time = String(a['last_synced_at'] ?? '').localeCompare(String(b['last_synced_at'] ?? ''));
          return time || Number(a['period_index']) - Number(b['period_index']);
        }).at(-1)!;
        insertCourse.run(
          survivorId,
          String(survivor['student_id']),
          String(survivor['school_year']),
          String(survivor['title']),
          sqlValue(newest['teacher'] ?? null),
          sqlValue(newest['room'] ?? null),
          sqlValue(newest['period'] ?? null),
          sqlValue(newest['last_synced_at'] ?? null),
          group.every((course) => Number(course['stale']) === 1) ? 1 : 0,
        );

        for (const course of group) {
          const oldCourseId = String(course['id']);
          const markId = newId('mrk');
          survivorByOldCourse.set(oldCourseId, survivorId);
          markByOldCourse.set(oldCourseId, markId);
          insertMark.run(
            markId,
            survivorId,
            String(course['term_id']),
            sqlValue(course['grade_letter'] ?? null),
            sqlValue(course['grade_score'] ?? null),
            Number(course['missing_count'] ?? 0),
            sqlValue(course['last_synced_at'] ?? null),
            Number(course['stale'] ?? 0),
          );
        }
      }

      const oldAssignments = db.prepare(`
        SELECT a.*, c.term_id, t.period_index
        FROM assignments a
        JOIN courses c ON c.id = a.course_id
        JOIN terms t ON t.id = c.term_id
      `).all() as Row[];
      const assignmentGroups = new Map<string, Row[]>();
      for (const assignment of oldAssignments) {
        const survivorId = survivorByOldCourse.get(String(assignment['course_id']));
        if (!survivorId) throw new Error(`No migrated course for ${String(assignment['course_id'])}.`);
        const key = JSON.stringify([survivorId, assignment['ext_key']]);
        const group = assignmentGroups.get(key) ?? [];
        group.push(assignment);
        assignmentGroups.set(key, group);
      }

      const insertMembership = db.prepare(
        'INSERT OR IGNORE INTO assignment_terms (assignment_id, term_id) VALUES (?, ?)',
      );
      const deleteAssignment = db.prepare('DELETE FROM assignments WHERE id = ?');
      const updateAssignment = db.prepare(
        'UPDATE assignments SET course_id = ?, last_seen_at = ?, stale = ? WHERE id = ?',
      );
      for (const group of assignmentGroups.values()) {
        const ordered = [...group].sort((a, b) => {
          const firstSeen = String(a['first_seen_at']).localeCompare(String(b['first_seen_at']));
          return firstSeen || Number(a['period_index']) - Number(b['period_index']) || String(a['id']).localeCompare(String(b['id']));
        });
        const kept = ordered[0]!;
        const keptId = String(kept['id']);
        const survivorId = survivorByOldCourse.get(String(kept['course_id']))!;
        for (const assignment of group) {
          if (Number(assignment['stale']) === 0) {
            insertMembership.run(keptId, String(assignment['term_id']));
          }
          if (String(assignment['id']) !== keptId) deleteAssignment.run(String(assignment['id']));
        }
        const lastSeenAt = group.reduce(
          (latest, assignment) => String(assignment['last_seen_at']).localeCompare(latest) > 0
            ? String(assignment['last_seen_at'])
            : latest,
          '',
        );
        updateAssignment.run(
          survivorId,
          lastSeenAt,
          Math.min(...group.map((assignment) => Number(assignment['stale']))),
          keptId,
        );
      }

      const insertHistory = db.prepare(`
        INSERT INTO grade_history_new (id, mark_id, observed_at, grade_letter, grade_score)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const point of db.prepare('SELECT * FROM grade_history ORDER BY id').all() as Row[]) {
        const markId = markByOldCourse.get(String(point['course_id']));
        if (!markId) throw new Error(`No migrated mark for ${String(point['course_id'])}.`);
        insertHistory.run(
          Number(point['id']),
          markId,
          String(point['observed_at']),
          sqlValue(point['grade_letter'] ?? null),
          sqlValue(point['grade_score'] ?? null),
        );
      }

      db.exec(`
DROP TABLE grade_history;
DROP TABLE courses;
ALTER TABLE courses_new RENAME TO courses;
ALTER TABLE grade_history_new RENAME TO grade_history;
CREATE INDEX courses_student_year_stale ON courses(student_id, school_year, stale);
CREATE INDEX grade_history_mark ON grade_history(mark_id, observed_at);
`);

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`Gradebook v4 migration failed foreign_key_check: ${JSON.stringify(violations)}`);
      }
      // DROP TABLE records deferred violations against the old parent even
      // though the replacement now satisfies every reference. The explicit
      // check above is authoritative; clearing deferred mode discards those
      // obsolete counters before the runner commits.
      db.exec('PRAGMA defer_foreign_keys = OFF');
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(`
CREATE TABLE assignment_scores (
  id              INTEGER PRIMARY KEY,
  assignment_id   TEXT NOT NULL REFERENCES assignments(id),
  observed_at     TEXT NOT NULL,
  score           REAL,
  score_raw       TEXT,
  score_letter    TEXT,
  points_possible REAL
) STRICT;
CREATE INDEX assignment_scores_assignment ON assignment_scores(assignment_id, observed_at);

ALTER TABLE assignments ADD COLUMN scored_at TEXT;
`);
      const insert = db.prepare(`
        INSERT INTO assignment_scores
          (assignment_id, observed_at, score, score_raw, score_letter, points_possible)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const markScored = db.prepare('UPDATE assignments SET scored_at = first_seen_at WHERE id = ?');
      for (const row of db.prepare('SELECT * FROM assignments').all() as Row[]) {
        if (scoreKey(row['score'] as number | null, row['score_raw'] as string | null) === null) continue;
        insert.run(
          String(row['id']), String(row['first_seen_at']),
          sqlValue(row['score'] ?? null), sqlValue(row['score_raw'] ?? null),
          sqlValue(row['score_letter'] ?? null), sqlValue(row['points_possible'] ?? null),
        );
        markScored.run(String(row['id']));
      }
    },
  },
  {
    version: 6,
    up(db) {
      db.exec(`
ALTER TABLE assignments ADD COLUMN missing_at TEXT;
UPDATE assignments SET missing_at = first_seen_at
WHERE status IN ('missing', 'incomplete', 'late');
`);
    },
  },
];
