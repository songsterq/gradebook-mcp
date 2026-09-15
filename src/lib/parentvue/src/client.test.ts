import { describe, expect, it } from 'vitest';
import { ParentVueClient } from './client.js';
import { ParentVueError } from './errors.js';
import { deriveAssignmentStatus, normalizeDate, parseChildList } from './parse.js';

const LOGIN_BODY = {
  access_token: 'opaque-token',
  refresh_token: 'opaque-refresh',
  token_type: null,
  expires_in: null,
  scope: null,
};

const CHILD_LIST_DATA = {
  children: {
    childrenList: [
      {
        childIntID: 0,
        childName: 'Alex Rivera',
        childFirstName: 'Alex',
        organizationName: 'Test Middle School',
        grade: '06',
      },
      {
        childIntID: 1,
        childName: 'Mia Rivera',
        childFirstName: 'Mia',
        organizationName: 'Test Elementary',
        grade: '03',
      },
    ],
  },
};

function gradebookBook(overrides: { letter?: string; assignments?: unknown[] } = {}) {
  return {
    type: 'Traditional',
    errorMessage: null,
    reportingPeriods: [
      { index: 0, gradePeriod: 'Quarter 1', startDate: '9/2/2026', endDate: '11/6/2026' },
      { index: 1, gradePeriod: 'Semester 1 Final', startDate: '11/9/2026', endDate: '1/28/2027' },
    ],
    courses: [
      {
        period: 2,
        title: 'AL 6th Grade Science',
        room: 'B204',
        staff: 'Dylan Scott',
        staffEMail: 'scottd@example.test',
        marks: [
          {
            markName: 'Quarter 1',
            calculatedScoreString: overrides.letter ?? 'B',
            calculatedScoreRaw: '3.0',
            assignments:
              overrides.assignments ??
              [
                {
                  gradebookID: 1,
                  measure: 'Student Survey',
                  type: 'Habits',
                  date: '9/4/2026',
                  dueDate: '9/4/2026',
                  score: '3.5',
                  displayScore: '3.5 out of 4',
                  scoreType: 'Raw Score',
                  points: '4',
                  pointPossible: null,
                  notes: '',
                },
                {
                  gradebookID: 2,
                  measure: 'Syllabus Signature',
                  type: 'Homework',
                  date: '9/8/2026',
                  dueDate: '9/11/2026',
                  score: null,
                  displayScore: 'Not Graded',
                  scoreType: 'Raw Score',
                  points: '10 Points Possible',
                  pointPossible: null,
                  notes: 'Missing ',
                },
              ],
          },
        ],
      },
    ],
  };
}

function envelope(data: unknown) {
  return JSON.stringify({ error: null, data });
}

interface Route {
  method: string;
  respond: (inner: any) => Response;
}

/** Mock transport routing on the API path; records calls for assertions. */
function mockTransport(routes: Route[], loginBodies: unknown[] = [LOGIN_BODY]) {
  const calls: { method: string; inner: any; authorization: string | null }[] = [];
  let logins = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop() ?? '';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '{}';
    const inner = JSON.parse(JSON.parse(body).arguments.request);
    calls.push({ method, inner, authorization: headers.get('Authorization') });
    if (method === 'AttemptLogin') {
      const payload = loginBodies[Math.min(logins++, loginBodies.length - 1)];
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    const route = routes.find((r) => r.method === method);
    if (!route) throw new Error(`unexpected method ${method}`);
    return route.respond(inner);
  }) as typeof fetch;
  return { fetchImpl, calls, loginCount: () => logins };
}

function clientFor(routes: Route[], loginBodies?: unknown[]) {
  const { fetchImpl, calls, loginCount } = mockTransport(routes, loginBodies);
  const client = new ParentVueClient({ host: 'pxp.example.test', username: 'u', password: 'p', fetchImpl });
  return { client, calls, loginCount };
}

describe('login', () => {
  it('sends credentials as HTTP Basic with a null-body login request', async () => {
    const { client, calls, loginCount } = clientFor([
      { method: 'GetChildListData', respond: () => new Response(envelope(CHILD_LIST_DATA), { status: 200 }) },
    ]);
    await client.listChildren();
    const login = calls.find((c) => c.method === 'AttemptLogin')!;
    expect(login.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(login.inner).toEqual({ userID: null, password: null, userType: 'parent' });
    expect(loginCount()).toBe(1);
  });

  it('reuses the token across calls and sends it as a Bearer token', async () => {
    const { client, calls, loginCount } = clientFor([
      { method: 'GetChildListData', respond: () => new Response(envelope(CHILD_LIST_DATA), { status: 200 }) },
    ]);
    await client.listChildren();
    await client.listChildren();
    expect(loginCount()).toBe(1);
    expect(
      calls.filter((c) => c.method === 'GetChildListData').every((c) => c.authorization === 'Bearer opaque-token'),
    ).toBe(true);
  });

  it('rejects bad credentials with auth_failed', async () => {
    const { client } = clientFor([], [
      { error: { code: '401', message: 'Invalid user id or password' }, data: null },
    ]);
    await expect(client.listChildren()).rejects.toMatchObject({ code: 'auth_failed' });
  });

  it('re-authenticates once and retries after a 401', async () => {
    let gradebookCalls = 0;
    const { client, loginCount } = clientFor([
      {
        method: 'Gradebook',
        respond: () =>
          gradebookCalls++ === 0
            ? new Response(JSON.stringify({ error: { code: '401', message: 'expired' }, data: null }), { status: 200 })
            : new Response(envelope({ traditionalGradebook: gradebookBook() }), { status: 200 }),
      },
    ]);
    const snapshot = await client.getGradebook('0');
    expect(loginCount()).toBe(2);
    expect(snapshot.courses).toHaveLength(2); // both periods fetched after the retry
  });

  it('re-authenticates once and retries after an HTTP 401', async () => {
    let gradebookCalls = 0;
    const { client, loginCount } = clientFor([
      {
        method: 'Gradebook',
        respond: () =>
          gradebookCalls++ === 0
            ? new Response(null, { status: 401 })
            : new Response(envelope({ traditionalGradebook: gradebookBook() }), { status: 200 }),
      },
    ]);
    const snapshot = await client.getGradebook('0');
    expect(loginCount()).toBe(2);
    expect(snapshot.courses).toHaveLength(2);
  });
});

describe('listChildren', () => {
  it('maps the children list', async () => {
    const { client } = clientFor([
      { method: 'GetChildListData', respond: () => new Response(envelope(CHILD_LIST_DATA), { status: 200 }) },
    ]);
    const children = await client.listChildren();
    expect(children).toMatchObject([
      { id: '0', name: 'Alex Rivera', grade: '06', schoolName: 'Test Middle School' },
      { id: '1', name: 'Mia Rivera', grade: '03', schoolName: 'Test Elementary' },
    ]);
  });

  it('sends the double-encoded envelope', async () => {
    const { calls, client } = clientFor([
      { method: 'GetChildListData', respond: () => new Response(envelope(CHILD_LIST_DATA), { status: 200 }) },
    ]);
    await client.listChildren();
    const call = calls.find((c) => c.method === 'GetChildListData')!;
    expect(call.inner).toEqual({ childIntID: 0, languageCode: 'en' });
  });
});

describe('getStudentInfo', () => {
  it('returns detail for a known child', async () => {
    const { client } = clientFor([
      { method: 'GetChildListData', respond: () => new Response(envelope(CHILD_LIST_DATA), { status: 200 }) },
    ]);
    const info = await client.getStudentInfo('1');
    expect(info).toMatchObject({ id: '1', name: 'Mia Rivera', schoolName: 'Test Elementary', grade: '03' });
  });

  it('throws for an unknown child id', async () => {
    const { client } = clientFor([
      { method: 'GetChildListData', respond: () => new Response(envelope(CHILD_LIST_DATA), { status: 200 }) },
    ]);
    await expect(client.getStudentInfo('9')).rejects.toBeInstanceOf(ParentVueError);
  });
});

describe('getGradebook', () => {
  function gradebookClient() {
    return clientFor([
      {
        method: 'Gradebook',
        respond: () => new Response(envelope({ traditionalGradebook: gradebookBook() }), { status: 200 }),
      },
    ]);
  }

  it('fetches one call per reporting period and merges marks', async () => {
    const { client, calls } = gradebookClient();
    const snapshot = await client.getGradebook('0');
    expect(snapshot.childId).toBe('0');
    expect(snapshot.reportingPeriods.map((p) => p.name)).toEqual(['Quarter 1', 'Semester 1 Final']);
    expect(snapshot.reportingPeriods[0]).toMatchObject({
      index: 0,
      startDate: '2026-09-02',
      endDate: '2026-11-06',
    });
    // Two periods -> two marks on the one course.
    expect(snapshot.courses).toHaveLength(2);
    expect(snapshot.courses[0]!.marks[0]!.reportingPeriod?.name).toBe('Quarter 1');
    expect(snapshot.courses[1]!.marks[0]!.reportingPeriod?.name).toBe('Semester 1 Final');
    const periods = calls.filter((c) => c.method === 'Gradebook').map((c) => c.inner.reportPeriod);
    expect(periods).toEqual([0, 1]);
    expect(calls.find((c) => c.method === 'Gradebook')!.inner.childIntID).toBe(0);
  });

  it('maps course, mark, and assignment fields', async () => {
    const { client } = gradebookClient();
    const snapshot = await client.getGradebook('0');
    const course = snapshot.courses[0]!;
    expect(course).toMatchObject({
      title: 'AL 6th Grade Science',
      period: '2',
      room: 'B204',
      teacher: 'Dylan Scott',
      teacherEmail: 'scottd@example.test',
    });
    const mark = course.marks[0]!;
    expect(mark).toMatchObject({ letter: 'B', score: 3.0, scoreRaw: '3.0', periodIndex: 0 });
    const [survey, syllabus] = mark.assignments;
    expect(survey).toMatchObject({
      id: '1',
      title: 'Student Survey',
      category: 'Habits',
      type: 'Raw Score',
      date: '2026-09-04',
      dueDate: '2026-09-04',
      score: 3.5,
      scoreRaw: '3.5',
      pointsPossible: 4,
      status: 'scored',
    });
    expect(syllabus).toMatchObject({
      id: '2',
      title: 'Syllabus Signature',
      status: 'missing',
      pointsPossible: 10,
      score: undefined,
    });
  });

  it('treats a null gradebook as empty, not an error', async () => {
    const { client } = clientFor([
      { method: 'Gradebook', respond: () => new Response(envelope({ traditionalGradebook: null }), { status: 200 }) },
    ]);
    const snapshot = await client.getGradebook('1');
    expect(snapshot).toEqual({
      childId: '1',
      reportingPeriods: [],
      courses: [],
      completePeriodIndexes: [],
    });
  });

  it('treats error 2100 (no gradebook at this school) as empty', async () => {
    const { client } = clientFor([
      {
        method: 'Gradebook',
        respond: () =>
          new Response(
            JSON.stringify({
              error: { code: '2100', message: 'Grade Book data not available for this school' },
              data: null,
            }),
            { status: 200 },
          ),
      },
    ]);
    const snapshot = await client.getGradebook('1');
    expect(snapshot.courses).toEqual([]);
  });
});

describe('transport errors', () => {
  it('maps unreachable hosts to network_error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const client = new ParentVueClient({ host: 'pxp.example.test', username: 'u', password: 'p', fetchImpl });
    await expect(client.listChildren()).rejects.toMatchObject({ code: 'network_error' });
  });

  it('maps non-JSON bodies to parse_error', async () => {
    const { client } = clientFor([
      { method: 'GetChildListData', respond: () => new Response('<html>nope</html>', { status: 200 }) },
    ]);
    await expect(client.listChildren()).rejects.toMatchObject({ code: 'parse_error' });
  });

  it('maps upstream error codes to upstream_error without leaking payloads', async () => {
    const { client } = clientFor([
      {
        method: 'GetChildListData',
        respond: () =>
          new Response(
            JSON.stringify({ error: { code: '500', message: 'A critical error has occurred. (37475)' }, data: null }),
            { status: 200 },
          ),
      },
    ]);
    const err = await client.listChildren().catch((e) => e);
    expect(err).toBeInstanceOf(ParentVueError);
    expect(err.code).toBe('upstream_error');
    expect(err.message).not.toContain('37475');
  });

  it('requires host, username, and password', () => {
    expect(() => new ParentVueClient({ host: '', username: 'u', password: 'p' })).toThrowError(
      expect.objectContaining({ code: 'not_configured' }),
    );
  });
});

describe('deriveAssignmentStatus', () => {
  it('trusts explicit markers; missing needs the notes flag', () => {
    expect(deriveAssignmentStatus({ notes: 'Missing ' })).toBe('missing');
    expect(deriveAssignmentStatus({ notes: 'Late turn-in' })).toBe('late');
    expect(deriveAssignmentStatus({ notes: 'Excused' })).toBe('excused');
    expect(deriveAssignmentStatus({ score: 3.5 })).toBe('scored');
  });

  it('does not infer missing from a past-due date alone', () => {
    // "Not Graded" work the teacher hasn't flagged is awaiting, not missing.
    expect(deriveAssignmentStatus({ dueDate: '2026-09-02' })).toBe('not_due');
    expect(deriveAssignmentStatus({})).toBe('not_due');
  });
});

describe('normalizeDate', () => {
  it('normalizes M/D/YYYY', () => {
    expect(normalizeDate('9/2/2026')).toBe('2026-09-02');
    expect(normalizeDate('11/06/2026')).toBe('2026-11-06');
  });
});

describe('parseChildList', () => {
  it('throws on a malformed payload', () => {
    expect(() => parseChildList({})).toThrowError(expect.objectContaining({ code: 'parse_error' }));
  });
});
