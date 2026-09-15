import type { Migration } from '../../storage/sqlite.js';

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
];
