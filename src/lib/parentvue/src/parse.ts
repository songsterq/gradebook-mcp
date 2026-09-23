import { ParentVueError } from './errors.js';

/** A child (student) on the parent account. */
export interface Child {
  /** District's student identifier (the API's `childIntID`, as a string). */
  id: string;
  /** Display name (`childName`). */
  name: string;
  grade?: string;
  schoolName?: string;
  /** Raw upstream fields, kept for forward-compatibility. */
  raw: Record<string, string>;
}

/** Extra demographic/school detail for one child. */
export interface StudentInfo {
  id: string;
  name?: string;
  schoolName?: string;
  grade?: string;
  raw: Record<string, string>;
}

/** One grading/reporting period (e.g. Quarter 1). */
export interface ReportingPeriod {
  /**
   * Position in the upstream list. The API addresses periods by this
   * 0-based index (`reportPeriod`), so it doubles as the request parameter.
   */
  index: number;
  /** Reserved for a stable district identifier; the JSON API exposes none. */
  gu: string;
  /** Display name, e.g. "Quarter 1" or "Semester 1 Final". */
  name: string;
  startDate?: string;
  endDate?: string;
}

export type AssignmentStatus =
  | 'missing'
  | 'late'
  | 'incomplete'
  | 'collected'
  | 'not_due'
  | 'excused'
  | 'scored';

/** One assignment row inside a course mark. */
export interface AssignmentSnapshot {
  /** Stable upstream identifier (`gradebookID`); may be empty if the feed omits it. */
  id: string;
  title: string;
  /** Assignment category (`type`), e.g. "Academic Habits". */
  category?: string;
  /** Scoring method (`scoreType`), e.g. "Raw Score", "Rubric 0-4", "Yes / No". */
  type?: string;
  /** Assigned date, normalized to YYYY-MM-DD when parseable. */
  date?: string;
  /** Due date, normalized to YYYY-MM-DD when parseable. */
  dueDate?: string;
  /** Numeric score, if the teacher posted one. */
  score?: number;
  /** Score exactly as reported (may be a code like "N"). */
  scoreRaw?: string;
  /** Letter/code mark where the teacher uses one instead of a number. */
  scoreLetter?: string;
  pointsPossible?: number;
  pointsRaw?: string;
  /** Derived by {@link deriveAssignmentStatus} from the upstream fields. */
  status: AssignmentStatus;
  notes?: string;
  raw: Record<string, string>;
}

/** A course's grade + assignments for one reporting period. */
export interface CourseMark {
  /** The reporting period this mark belongs to. */
  reportingPeriod: ReportingPeriod | null;
  periodIndex: number;
  letter?: string;
  score?: number;
  scoreRaw?: string;
  assignments: AssignmentSnapshot[];
  raw: Record<string, string>;
}

export interface CourseSnapshot {
  title: string;
  period?: string;
  room?: string;
  teacher?: string;
  teacherEmail?: string;
  marks: CourseMark[];
  raw: Record<string, string>;
}

export interface GradebookSnapshot {
  childId: string;
  reportingPeriods: ReportingPeriod[];
  courses: CourseSnapshot[];
  /** Periods whose Gradebook request returned a complete, non-null book. */
  completePeriodIndexes?: number[];
}

/** Raw JSON record from the API; values can be string, number, boolean, null, or nested. */
export type JsonRecord = Record<string, unknown>;

const MISSING_RE = /\bmissing\b/i;
const INCOMPLETE_RE = /\bincomplete\b/i;
const LATE_RE = /\blate\b/i;
const EXCUSED_RE = /\b(excused|exempt|exc)\b/i;
const COLLECTED_RE = /\b(collected|turned in|submitted|handed in)\b/i;

/**
 * Derive an assignment status from the raw upstream fields. Explicit textual
 * markers win; anything with a score counts as scored; everything else is
 * not yet due. Verified against a live district on 2026-09-13: the district
 * marks missing work explicitly in `notes` ("Missing"), while unscored
 * past-due work the teacher hasn't flagged shows "Not Graded" — so unlike
 * the old heuristic, a past-due date alone does NOT imply missing. That is
 * why this takes no "today": the status is read off the feed, never inferred
 * from the calendar.
 */
export function deriveAssignmentStatus(fields: {
  notes?: string;
  scoreType?: string;
  score?: number;
  dueDate?: string;
}): AssignmentStatus {
  const haystack = `${fields.notes ?? ''} ${fields.scoreType ?? ''}`;
  if (EXCUSED_RE.test(haystack)) return 'excused';
  if (MISSING_RE.test(haystack)) return 'missing';
  if (INCOMPLETE_RE.test(haystack)) return 'incomplete';
  if (COLLECTED_RE.test(haystack)) return 'collected';
  if (LATE_RE.test(haystack)) return 'late';
  if (fields.score !== undefined) return 'scored';
  return 'not_due';
}

/** Normalize the district's date strings (usually M/D/YYYY) to YYYY-MM-DD when possible. */
export function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(trimmed);
  if (m) {
    const [, month, day, year] = m;
    return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (m) return trimmed.slice(0, 10);
  return trimmed || undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? undefined : t;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function arr(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((v): v is JsonRecord => typeof v === 'object' && v !== null) : [];
}

/** Scalar upstream fields, stringified, for forward-compatible debugging. */
function rawRecord(value: JsonRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val === null || val === undefined) continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[key] = String(val);
    }
  }
  return out;
}

/**
 * Parse the `GetChildListData` response `data` object into children.
 * Throws ParentVueError on malformed payloads.
 */
export function parseChildList(data: unknown): Child[] {
  const root = (typeof data === 'object' && data !== null ? data : {}) as JsonRecord;
  const children = (root.children as JsonRecord | undefined) ?? root;
  const list = arr(children.childrenList ?? children.childList);
  if (list.length === 0 && !Array.isArray(children.childrenList) && !Array.isArray(children.childList)) {
    throw new ParentVueError('parse_error', 'GetChildListData response has no children list.');
  }
  return list.map((entry) => {
    const id = str(entry.childIntID ?? entry.ID);
    if (id === undefined) throw new ParentVueError('parse_error', 'ChildList entry is missing its childIntID.');
    return {
      id,
      name: str(entry.childName) ?? 'Unknown',
      grade: str(entry.grade),
      schoolName: str(entry.organizationName ?? entry.schoolName),
      raw: rawRecord(entry),
    };
  });
}

/** Build per-child detail from a Child record (the list response already carries it). */
export function parseStudentInfo(child: Child): StudentInfo {
  return {
    id: child.id,
    name: child.name,
    schoolName: child.schoolName,
    grade: child.grade,
    raw: child.raw,
  };
}

/** Parse the `traditionalGradebook.reportingPeriods` array. */
export function parseReportingPeriods(traditionalGradebook: unknown): ReportingPeriod[] {
  const tgb = (typeof traditionalGradebook === 'object' && traditionalGradebook !== null
    ? traditionalGradebook
    : {}) as JsonRecord;
  return arr(tgb.reportingPeriods).map((p, i) => {
    const index = num(p.index) ?? i;
    return {
      index,
      gu: '',
      name: str(p.gradePeriod) ?? `Period ${index + 1}`,
      startDate: normalizeDate(str(p.startDate)),
      endDate: normalizeDate(str(p.endDate)),
    };
  });
}

function finite(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The `points` display string: "100 / 100" -> 100; "10 Points Possible" -> 10. */
function pointsFromPointsField(pointsRaw: string | undefined): number | undefined {
  if (!pointsRaw) return undefined;
  const m = /\/\s*([\d.]+)\s*$/.exec(pointsRaw) ?? /^\s*([\d.]+)/.exec(pointsRaw);
  return finite(m?.[1]);
}

/**
 * The `displayScore` string the ParentVUE app itself prints: "3.5 out of 4",
 * "3.5 / 4". Only the denominator counts here — a leading number is the score,
 * not the total — which is why this can't reuse {@link pointsFromPointsField}.
 */
function pointsFromDisplayScore(displayScore: string | undefined): number | undefined {
  if (!displayScore) return undefined;
  return finite(/(?:\/|\bout\s+of\b)\s*([\d.]+)\s*$/i.exec(displayScore)?.[1]);
}

/** Rubric score types carry their ceiling in the name: "Rubric 0 - 4" -> 4. */
function pointsFromScoreType(scoreType: string | undefined): number | undefined {
  if (!scoreType) return undefined;
  return finite(/rubric\D*[\d.]+\s*(?:-|–|to)\s*([\d.]+)/i.exec(scoreType)?.[1]);
}

/**
 * Points possible, from whichever upstream field actually carries it. One district
 * posts rubric-scored work with `pointPossible` null and `points` empty while
 * still showing "3.5 out of 4" in the app, so `displayScore` and the rubric
 * range in `scoreType` are real sources, not guesses. A non-positive value is
 * only accepted when nothing else offers a positive one: districts use 0 for
 * "not set" far more often than for a genuinely 0-point assignment.
 */
function parsePointsPossible(entry: JsonRecord): { pointsPossible?: number; pointsRaw?: string } {
  const pointsRaw = str(entry.points);
  const candidates = [
    num(entry.pointPossible ?? entry.point),
    pointsFromPointsField(pointsRaw),
    pointsFromDisplayScore(str(entry.displayScore)),
    pointsFromScoreType(str(entry.scoreType)),
  ];
  const pointsPossible =
    candidates.find((n) => n !== undefined && n > 0) ?? candidates.find((n) => n !== undefined);
  return { pointsPossible, pointsRaw };
}

function parseAssignment(entry: JsonRecord): AssignmentSnapshot {
  const scoreRaw = str(entry.score);
  const score = num(entry.score);
  const scoreType = str(entry.scoreType);
  const notes = str(entry.notes);
  const dueDate = normalizeDate(str(entry.dueDate));
  const { pointsPossible, pointsRaw } = parsePointsPossible(entry);
  return {
    id: str(entry.gradebookID) ?? '',
    title: str(entry.measure) ?? 'Untitled assignment',
    category: str(entry.type),
    type: scoreType,
    date: normalizeDate(str(entry.date)),
    dueDate,
    score,
    scoreRaw,
    scoreLetter: score === undefined && scoreRaw !== undefined && /[a-zA-Z]/.test(scoreRaw) ? scoreRaw : undefined,
    pointsPossible,
    pointsRaw,
    status: deriveAssignmentStatus({ notes, scoreType, score, dueDate }),
    notes,
    raw: rawRecord(entry),
  };
}

/**
 * Parse the courses (with one mark each) for a single reporting period out
 * of a `traditionalGradebook` object.
 */
export function parseCourses(
  traditionalGradebook: unknown,
  period: ReportingPeriod | null,
  periodIndex: number,
): CourseSnapshot[] {
  const tgb = (typeof traditionalGradebook === 'object' && traditionalGradebook !== null
    ? traditionalGradebook
    : {}) as JsonRecord;
  return arr(tgb.courses).map((course) => {
    const marks = arr(course.marks).map((mark) => {
      const scoreRaw = str(mark.calculatedScoreRaw);
      const score = num(mark.calculatedScoreRaw);
      return {
        reportingPeriod: period,
        periodIndex,
        letter: str(mark.calculatedScoreString),
        score,
        scoreRaw,
        assignments: arr(mark.assignments).map(parseAssignment),
        raw: rawRecord(mark),
      };
    });
    return {
      title: str(course.title) ?? 'Untitled course',
      period: str(course.period),
      room: str(course.room),
      teacher: str(course.staff),
      teacherEmail: str(course.staffEMail),
      marks,
      raw: rawRecord(course),
    };
  });
}
