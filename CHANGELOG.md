# Changelog

## 2.0.0

### New tools

- Work packages: `set_status`, `validate_update` (dry run through OpenProject's
  form), `create_work_packages` (batch, `parentIndex`, `dedupeBy: "subject"`).
- Comments: `add_comment`, `list_activities`, `edit_comment`.
- Relations, watchers, time: `list_relations`, `delete_relation`,
  `list_watchers`, `add_watcher`, `list_time_entries`.
- Projects and reference data: `get_project`, `create_project`,
  `list_project_types`, `list_versions`, `create_version`, `list_memberships`,
  `add_membership`, `list_priorities`, `list_roles`, `find_user`.
- `get_work_package`, `update_work_package`, `list_work_packages` and
  `create_work_package` were rewritten: names for status, type, priority and
  role; `lockVersion` read for you, a 409 retried once when safe; `notify`.

### Security

- Same origin only: an absolute URL to any other origin is refused
  (`FOREIGN_ORIGIN`) before a request is made.
- Redirects are never followed. `lib/api.js` and the `users/me` token check
  use `redirect: "error"`; a 3xx is refused with `REDIRECT_REFUSED`. The admin
  web session (status admin) has to read the 302 of its login form, so it
  keeps `redirect: "manual"`, follows same-origin redirects itself and refuses
  any other origin with `REDIRECT_REFUSED`.
- Every id and project identifier that goes into a path passes through
  `lib/path.js` `seg()`; `"1/../../projects/x"` or `"5?x="` is refused with
  `INVALID_ID` before anything is sent. Identifiers are lowercase, like
  OpenProject's.
- Fail-closed configuration: no default `OPENPROJECT_URL`.
- HTTP mode runs every call as the caller (`NO_CALLER_TOKEN` otherwise);
  validated tokens are cached for 60 s keyed by SHA-256.
- Timeouts: `OPENPROJECT_TIMEOUT_MS` (default 30 s) bounds API calls, the
  `users/me` token check and the admin web session (`TIMEOUT`).
- An HTTP body over 1 MiB gets 413 and the request is destroyed instead of
  read to the end, also for chunked bodies with no `Content-Length`.
- A session's idle clock is refreshed only after the caller's identity
  matches the session.

### Fixes

- `create_work_packages` with `dedupeBy: "subject"` asks OpenProject for
  `subject ~` (the only text operator it has besides `!~`, `*`, `!*`) within
  the project itself (not its subprojects) and checks the exact subject and
  parent itself.
- Logins are resolved through `/api/v3/principals`; `/api/v3/users`, which
  OpenProject only answers for admins, is the fallback.
- Errors from the work-package tools keep OpenProject's `errorIdentifier`,
  `attribute` and message, and carry `allowedStatuses` / `allowedTypes` as
  structured fields.

### Breaking changes

- **Links are `{id, name}`** (numeric id plus the link title) instead of bare
  names or hrefs, in every named tool's result.
- **`list_work_packages` returns `{total, offset, pageSize, hasMore, elements}`**
  instead of a bare array. The default `pageSize` stays 100.
- **Errors are JSON**: `isError: true` with
  `{"error": {code, httpStatus, errorIdentifier, attribute, message, hint,
  allowedStatuses?, allowedTypes?}}` instead of plain text. Codes are
  UPPER_SNAKE, for example `UPDATE_CONFLICT` (409, errorIdentifier
  `urn:openproject-org:api:v3:errors:UpdateConflict`), `INVALID_TRANSITION`,
  `TYPE_NOT_ALLOWED`, `INVALID_ID`, `INVALID_ARGUMENT`, `REDIRECT_REFUSED`,
  `TIMEOUT`.
- **`raw_api_call` returns `{hint, result}`** when a typed tool covers the call
  (`{"hint": "<tool> covers this", "result": ...}`); otherwise the OpenProject
  response as before.
- **Unknown arguments are refused** (with the accepted names and a "did you
  mean") instead of ignored; nothing is sent.
- **The default type is now the project's first allowed type** for
  `create_work_package` (it was type id 1).
- Arguments that take an id or a name (`status`, `type`, `priority`,
  `assigneeId`, `userId`, `projectId`, `project`, `parentId` of a project,
  `roles[]`, `estimatedTime`, `remainingTime`) are declared `type: "string"`
  in the schemas, because some function-calling gateways reject union types;
  numbers are still accepted.
- An empty string for `subject` or `description` still means "absent";
  emptying a field goes only through `clear: [...]`.
