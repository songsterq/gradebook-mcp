# parentvue

A tiny, dependency-free TypeScript client for the ParentVUE / StudentVUE
mobile JSON API (`https://<district-host>/api/v1/mobile/PXPWebServices`) —
the same interface the current ParentVUE and StudentVUE mobile apps use.

**Read-only by design.** Every method fetches data; nothing writes back to
the district.

## Install

```sh
npm install parentvue
```

## Usage

```ts
import { ParentVueClient } from 'parentvue';

const client = new ParentVueClient({
  host: 'district.edupoint.com', // your district's ParentVUE host, no scheme
  username: process.env.PARENTVUE_USER!,
  password: process.env.PARENTVUE_PASS!,
  parent: true, // parent login (child list); false for a student login
});

const children = await client.listChildren();
for (const child of children) {
  const gradebook = await client.getGradebook(child.id);
  for (const period of gradebook.reportingPeriods) {
    console.log(period.name, period.startDate, '→', period.endDate);
  }
  for (const course of gradebook.courses) {
    for (const mark of course.marks) {
      const missing = mark.assignments.filter((a) => a.status === 'missing');
      console.log(course.title, mark.letter, mark.score, `${missing.length} missing`);
    }
  }
}
```

## API

- `new ParentVueClient({ host, username, password, parent?, fetchImpl?, timeoutMs?, userAgent? })`
  - `listChildren(todayYmd?)` → `Child[]` (`id`, `name`, `grade`, `schoolName`)
  - `getStudentInfo(childId)` → `StudentInfo`
  - `getGradebook(childId, todayYmd?)` → `GradebookSnapshot` — every reporting
    period the district exposes, each course's per-period marks, and each
    mark's assignment rows (`id`, `title`, `category`, `dueDate`, `score`,
    `pointsPossible`, `status`, `notes`, plus the raw upstream fields)
- `deriveAssignmentStatus(fields, todayYmd)` — the status heuristic, exported
  so callers can re-derive it
- `parseChildList` / `parseCourses` / `parseReportingPeriods` /
  `parseStudentInfo` — parse saved payloads without network access
- `ParentVueError` with `.code`: `not_configured` | `auth_failed` |
  `network_error` | `upstream_error` | `parse_error`. Messages never contain
  credentials or response bodies.

`fetchImpl` accepts any `fetch`-compatible function, so tests (and consumers)
can inject fixtures.

## Protocol

Each method is a `POST` to
`/api/v1/mobile/PXPWebServices/<MethodName>` with a double-encoded JSON
envelope:

```json
{ "arguments": { "request": "{\"childIntID\":0,\"languageCode\":\"en\"}" } }
```

Login is a token exchange: `AttemptLogin` takes the credentials in the
HTTP Basic header (the request body carries only `userID: null`) and returns
an opaque bearer token used for subsequent calls. The client logs in lazily,
reuses the token, and re-authenticates once on a 401.

Every data response is an envelope with an `error` field: a 200 response
with a non-null `error` is still a failure, and callers must check it.
Error `2100` ("Grade Book data not available for this school") is treated as
a benign-empty gradebook.

## Assignment status

The API marks missing work explicitly in the assignment `notes` field
(`"Missing "`), so status is derived from explicit markers: `missing`,
`incomplete`, `late`, `excused`, `collected` win; anything with a score is
`scored`; everything else is `not_due`. A past-due date alone does **not**
imply missing — unscored past-due work the teacher hasn't flagged is awaiting
a grade, not missing.

## Verified against

- A Synergy district on an `*.edupoint.com` host, parent
  login, 2026-09-13: `AttemptLogin`, `GetChildListData`, and `Gradebook`
  all exercised live through this client, including the missing-work
  `notes` marker and the benign-empty (error 2100 / null gradebook) cases.

Note: this API is the apps' current mobile interface, not a published public
API. Edupoint retired the legacy SOAP service (`PXPCommunication.asmx`) in
August 2026; districts may change this interface without notice.

## Extracting from gradebook-mcp

This directory is self-contained: it imports nothing from the surrounding
repo, has zero runtime dependencies, and ships its own tests and package
metadata. To publish it standalone, copy this directory to a new repository
(or `git subtree split -P src/lib/parentvue`), then `npm install` the dev
toolchain and `npm publish`.

Inside gradebook-mcp it is **not** a pnpm workspace member, so its own
`package.json` scripts do not run in place — there is no `node_modules` here.
The repo's root `tsc` and `vitest` already compile and test these files; the
`package.json` and `tsconfig.json` exist so the directory is ready to lift
out. The local `tsconfig.json` deliberately duplicates the root compiler
options (rather than extending it) so it still works once extracted; keep the
two in step when the root's strictness changes.

## License

MIT
