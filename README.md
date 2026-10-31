# OpenProject MCP Server

Model Context Protocol (MCP) server for OpenProject API integration. Enables AI assistants to interact with OpenProject work packages, projects, and time tracking.

This CloudBSD fork adds first-class write tools for [status.cloudbsd.org](https://status.cloudbsd.org) against OpenProject API v3.

Version 2.0.0 changes result and error shapes; see [CHANGELOG.md](CHANGELOG.md) for the breaking changes.

## Installation

### Global Installation (Recommended)

```bash
npm install -g openproject-mcp
```

### Local Installation

```bash
npm install openproject-mcp
```

## Configuration

### Get OpenProject API Key

1. Log into your OpenProject instance
2. Go to **My Account** → **Access tokens**
3. Create a new API token
4. Copy the token

### Add to Kiro MCP Config

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "openproject": {
      "command": "npx",
      "args": ["-y", "openproject-mcp"],
      "env": {
        "OPENPROJECT_URL": "https://your-openproject-instance.com",
        "OPENPROJECT_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "openproject": {
      "command": "openproject-mcp",
      "env": {
        "OPENPROJECT_URL": "https://your-openproject-instance.com",
        "OPENPROJECT_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## CloudBSD status.cloudbsd.org write path

`status_upsert`, `build_annotate`, and `relation_upsert` write CloudBSD status work packages used by status.cloudbsd.org.

**Write target is DEV / trackdev.** Point `OPENPROJECT_URL` at the CloudBSD trackdev OpenProject instance. Do not enable or document production track as the default MCP write path. There is no parallel status-mcp source of truth; these tools live in this server.

Env stays `OPENPROJECT_URL` + `OPENPROJECT_API_KEY`.

The CloudBSD project identifier is `cloudbsd`. Components/lanes are first-class peers: `Desktop`, `HackMiami`, `Server`, `Wayfire`, `Ports-InternalPkg`, `Product-Media`, `CI-Jenkins`, `Networking`, `Status`. Node-map edges use native OpenProject relations (`relates`, `blocks`, `precedes`) rather than custom graph fields.

## Available Tools

Use the named tools; `raw_api_call` is a last resort for endpoints no tool covers.

Rules shared by the named tools (everything below except the upstream `list_projects`, `get_children`, `list_statuses`, `list_types`, `get_user`, `log_time`, the status-admin and the CloudBSD status tools):

- **Unknown argument names are refused**, with the accepted names and a "did you mean" for close matches. Nothing is sent to OpenProject.
- **A `null` argument is treated as absent, and so is `""` for `subject` or `description`.** To empty a field on update, use `clear: ["parentId", "dueDate", "description", ...]`.
- **Status, type, priority and role take names** (case-insensitive) or ids. Types are resolved in the project's own types.
- **No union types in schemas.** An argument that takes an id or a name is declared `type: "string"` (some function-calling gateways reject `["string","number"]`); a number is accepted too.
- **Links are `{id, name}`** with numeric ids. Every work-package result carries `lockVersion`, `updatedAt`, `project {id, identifier?, name}` and `url` (the web page).
- **`notify`** (default `true`; `false` for `create_work_packages`) is sent as `?notify=false`.
- Ids and project identifiers are validated by `seg()` before they go into a path (`INVALID_ID` otherwise; identifiers are lowercase).

### Work packages

| Tool | Arguments | Returns |
|------|-----------|---------|
| `get_work_package` | `id` (alias `workPackageId`), `includeComments` (N newest, default 0, max 50) | `{id, subject, description, status, type, priority, assignee, responsible, author, version, parent, parentId, ancestors:[{id,name}], childIds, project, startDate, dueDate, derivedStartDate, derivedDueDate, scheduleManually, percentageDone, estimatedTime, remainingTime, createdAt, updatedAt, lockVersion, url, comments?}` |
| `update_work_package` | `id`/`workPackageId`, `subject`, `description`, `status` (name/id) or `statusId`, `priority`, `assigneeId` (id or `"me"`), `versionId`, `parentId`, `startDate`, `dueDate`, `scheduleManually`, `percentageDone`, `estimatedTime`, `remainingTime` (ISO duration or hours), `comment`, `clear[]`, `lockVersion`, `notify` | `{id, subject, status, type, assignee, project, parentId, percentageDone, startDate, dueDate, lockVersion, updatedAt, url, retried, commentId? \| comment:{error}?}` |
| `set_status` | `id`, `status` or `statusId`, `percentageDone?`, `comment?`, `lockVersion?`, `notify?` | as `update_work_package` |
| `validate_update` | same as `update_work_package` (`comment`, `notify` ignored) | `{valid, errors:[{attribute,message}], allowedStatuses:[{id,name}], resulting:{startDate,dueDate,derivedStartDate,derivedDueDate}}` — writes nothing |
| `list_work_packages` | `projectId`, `ids[]`, `parentId`, `assigneeId`, `status` (name/id, `"open"`, `"closed"`, `"all"`), `type`, `search` (full text), `subject` (contains), `sortBy` (`"updatedAt:desc"`), `pageSize` (default 100, max 500), `offset` (page number, 1-based), `fields[]` | `{total, offset, pageSize, hasMore, elements:[{id, ...fields}]}`; default fields `id, subject, status, type, assignee, parentId` |
| `create_work_package` | `projectId`, `subject`, `description`, `type` (name/id; default the project's first allowed type) or `typeId`, `status`, `priority`, `parentId`, `assigneeId`, `versionId`, `startDate`, `dueDate`, `scheduleManually`, `estimatedTime`, `remainingTime`, `percentageDone`, `notify` | `{id, subject, status, type, project, parentId, lockVersion, updatedAt, url}` |
| `create_work_packages` | `projectId`, `items[]` (create fields + `parentIndex`), `dedupeBy: "subject"`, `notify` (default false) | `{created:[{index,id}], existing:[{index,id}], failed:[{index,error}]}` — never all-or-nothing. `dedupeBy` searches the project itself (not subprojects) with `subject ~`, then matches the exact subject and parent |
| `get_children` | `parentId` | `[{id, subject, status, type, assignee}]` (names) |
| `log_time` | `workPackageId`, `hours`, `comment`, `spentOn`, `activityId` | `{id, hours, spentOn, workPackageId, comment}` |

`update_work_package` reads `lockVersion` itself. On a 409 it re-reads and retries once, only if none of the fields it writes changed between the two reads (otherwise it fails with code `UPDATE_CONFLICT` and errorIdentifier `urn:openproject-org:api:v3:errors:UpdateConflict`); it never retries when you passed `lockVersion`. On a 422 from a status change it asks OpenProject's form which statuses are allowed and fails with code `INVALID_TRANSITION` and `allowedStatuses: [{id,name}]`. A type the project refuses on create fails with `TYPE_NOT_ALLOWED` and `allowedTypes: [{id,name}]`. These errors keep OpenProject's `errorIdentifier`, `attribute` and message. A `comment` is posted after the PATCH; if only the comment fails, the call still succeeds with `comment: {error}` — do not redo the update.

### Comments

| Tool | Arguments | Returns |
|------|-----------|---------|
| `add_comment` | `id`/`workPackageId`, `comment`, `notify` | `{activityId, workPackageId, createdAt}` (`#NNN` auto-links to work package NNN) |
| `list_activities` | `id`/`workPackageId`, `limit` (default 20, max 100), `order` (`desc`/`asc`), `commentsOnly` | `{workPackageId, total, count, hasMore, elements:[{id, createdAt, user:{id,name}, comment, changes[], truncated?}]}` (comments cut at 2000 chars) |
| `edit_comment` | `activityId`, `comment` | `{activityId, workPackageId, updatedAt}` |

### Relations, watchers, time

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_relations` | `id` | `[{id, type, from:{id,name}, to:{id,name}, description}]` |
| `relation_upsert` | `fromId`, `toId`, `type` (`relates`/`blocks`/`precedes`), `description` | idempotent create; `{id, type, reverseType, fromId, toId, description, action}` |
| `delete_relation` | `relationId`, `confirm: true` | `{deleted, relationId}` |
| `list_watchers` | `id` | `[{id, name}]` |
| `add_watcher` | `id`, `userId` (id or `"me"`) | `{workPackageId, watcher:{id,name}}` |
| `list_time_entries` | `id` | `{total, count, hasMore, elements:[{id, hours, spentOn, user, activity, comment}]}` |

### Projects and reference data

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_projects` | `pageSize` | `[{id, name, identifier, status}]` |
| `get_project` | `project` (id or identifier) | `{id, identifier, name, parentId, active, public}` |
| `create_project` | `name`, `identifier`, `parentId?`, `description?`, `public` (default false) | as `get_project` |
| `list_project_types` | `project` | `[{id, name}]` — the types a project allows |
| `list_versions` | `project` | `[{id, name, status, startDate, endDate, project}]` |
| `create_version` | `project`, `name`, `startDate?`, `endDate?`, `status` (default `open`) | `{id, name, status, startDate, endDate, project}` |
| `list_memberships` | `project` | `[{id, principal:{id,name}, roles:[{id,name}]}]` |
| `add_membership` | `project`, `userId`, `roles[]` (names or ids) | `{id, principal, roles}` |
| `list_priorities` | — | `[{id, name, isDefault}]` |
| `list_roles` | — | `[{id, name}]` |
| `list_statuses` | — | `[{id, name, isClosed, isDefault}]` |
| `list_types` | — | `[{id, name, color}]` (all types; see `list_project_types`) |
| `find_user` | `login` (exact) or `name` (contains) | `[{id, name, login?}]`. Logins are matched through `/api/v3/principals`, falling back to `/api/v3/users`, which only admins may read: searching by login may need admin |
| `get_user` | `userId` (id or `me`) | `{id, name, login, email, status}` |

### Status admin and CloudBSD status

| Tool | Description |
|------|-------------|
| `get_status` | Get one status by id (API v3) |
| `create_status` | Create a work-package status (rails runner or admin HTML; API v3 is GET-only) |
| `update_status` | Update/rename a status (admin HTML session) |
| `status_upsert` | Create or update a CloudBSD status work package by component/lane |
| `build_annotate` | Attach or update Jenkins build annotation custom fields on a work package |
| `raw_api_call` | Last resort: a raw call to any endpoint |

## Usage Examples

### List Children of a Feature

```javascript
get_children({ parentId: 211 })
```

### Create a New Task

```javascript
create_work_package({
  projectId: "cloudbsd",
  subject: "Implement token budget management",
  parentId: 538,
  assigneeId: 10,
  startDate: "2026-01-15",
  dueDate: "2026-01-15"
})
```

### List Tasks Assigned to Me

```javascript
list_work_packages({ assigneeId: "me" })
```

### Update Work Package Status

```javascript
update_work_package({
  id: 123,
  status: "In progress",  // name or id; statusId also works
  estimatedTime: "PT2H",  // ISO 8601 duration, or a number of hours
  comment: "Started on this"
})
```

### Log Time

```javascript
log_time({
  workPackageId: 123,
  hours: 2.5,
  comment: "Implemented feature X",
  spentOn: "2026-01-23"
})
```

### Upsert a CloudBSD status lane

```javascript
status_upsert({
  component: "Server",
  done: ["bhyve guest boots"],
  next: "wire status portal",
  direction: "keep Server first-class"
})
```

`lane` is accepted as an alias for `component`. Optional `jenkins_job`, `jenkins_number`, and `jenkins_url` custom fields can be set on the same call.

### Annotate a Jenkins build

```javascript
build_annotate({
  workPackageId: 41,
  jenkins_job: "cloudbsd-iso",
  jenkins_number: 18,
  jenkins_url: "https://ci.example.invalid/job/cloudbsd-iso/18/"
})
```

### Ensure a node-map relation

```javascript
relation_upsert({
  fromId: 11,
  toId: 22,
  type: "relates_to"
})
```

`relates_to` is stored as native OpenProject `relates`. `blocks` and `precedes` are also accepted. Repeating the same edge returns the existing relation.

### Admin: create / rename work-package statuses

OpenProject **API v3 Statuses are GET-only**. `create_status` / `update_status` mutate via:

1. **`rails`** (preferred on the OpenProject host) — `bin/rails runner` with `OPENPROJECT_ENVFILE` (survives admin 2FA)
2. **`web`** — admin HTML session (CSRF + cookie); fails closed with `LOGIN_REQUIRES_2FA` when login redirects to two-factor

`OPENPROJECT_STATUS_BACKEND=auto|rails|web` (default `auto`: rails when envfile + `bin/rails` are readable). Passwords are **never** tool arguments — only env / 0600 files for the web path.

```javascript
create_status({ name: "PR Ready", color: "#74C0FC" })
update_status({ id: 9, name: "Ready for testing" })
get_status({ id: 9 })
```

Idempotent create: if the name already exists, returns the existing status with `idempotent: true` (unless `force: true`).

## Security

- **Same origin only.** Every request goes to `OPENPROJECT_URL`. An absolute
  URL (for example a `_links.schema.href` from OpenProject) is accepted only
  when its scheme, host and port equal the configured URL's; any other origin
  is refused with code `FOREIGN_ORIGIN` before anything is sent, so a
  prompt-injected URL in work-package text cannot carry the caller's token
  elsewhere. Ids placed into paths go through `lib/path.js` `seg()`.
- **Fail-closed configuration.** There is no default URL. If `OPENPROJECT_URL`
  is unset, invalid, or still the example placeholder, both `index.js` (stdio)
  and `http.js` refuse to start with a message naming the variable.
- **Caller token only in HTTP mode.** `http.js` runs every tool call with the
  caller's Bearer token and never falls back to `OPENPROJECT_API_KEY`; a call
  without caller context fails with code `NO_CALLER_TOKEN`. Validated tokens
  are cached for 60 s (at most 1000, keyed by SHA-256 of the token, never the
  token itself). Sessions idle for 30 minutes with no open stream are closed.
- **No redirects.** API calls and the `users/me` token check use
  `redirect: "error"`; a 3xx is refused with code `REDIRECT_REFUSED`, so the
  token never follows a redirect. The admin web session (status admin) must
  read its login form's 302, so it uses `redirect: "manual"`, follows only
  same-origin Locations itself, and refuses others with `REDIRECT_REFUSED`.
- **Limits.** OpenProject requests (API, `users/me`, admin web session) time
  out after 30 s (`OPENPROJECT_TIMEOUT_MS`, error code `TIMEOUT`). An HTTP
  request body over 1 MiB, declared or chunked, gets 413 and the request is
  destroyed rather than read to the end. A session's idle clock is refreshed
  only after the caller's identity matches the session.
- **Errors** come back as `isError: true` with a JSON body
  `{"error":{"code","httpStatus","errorIdentifier","attribute","opMessage","message","hint","allowedStatuses","allowedTypes"}}`
  (fields that are not known are left out); `errorIdentifier` is exactly what
  OpenProject sent. `opMessage` is OpenProject's own message, given when the
  tool's `message` does not already quote it. Codes are UPPER_SNAKE.
- **`raw_api_call` is a last resort.** It accepts `endpoint` or `path`, a
  `query` object and any-case `method`, and refuses unknown arguments; when a
  typed tool covers the call (for example `get_work_package`,
  `update_work_package`, `add_comment`, `list_relations`, `log_time`) the
  answer is `{ "hint": "<tool> covers this", "result": ... }`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENPROJECT_URL` | Yes | OpenProject instance URL. For CloudBSD status writes, use trackdev (DEV). |
| `OPENPROJECT_TIMEOUT_MS` | No | Per-request OpenProject timeout in ms (default 30000) |
| `OPENPROJECT_API_KEY` | Yes* | API key from OpenProject (*stdio mode; HTTP caller-token mode uses client Bearer instead) |
| `OPENPROJECT_WEB_USER` | For status admin | OpenProject login username (e.g. `mlapointe`) |
| `OPENPROJECT_WEB_PASSWORD_FILE` | For status admin | Path to 0600 file containing the web password (never inline in config) |

Aliases: `TRACK_WEB_USER`, `TRACK_WEB_PASSWORD_FILE`.

## Requirements

- Node.js >= 18.0.0
- OpenProject instance with API access
- Admin web login for `create_status` / `update_status`

## Tests

```bash
npm test
```

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Links

- [OpenProject API Documentation](https://www.openproject.org/docs/api/)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## Caller-token auth (Approach A)

HTTP mode (`openproject-mcp-http` / `http.js`) requires:

```http
Authorization: Bearer <OpenProject API access token for that person>
```

The gateway validates the token with `GET /api/v3/users/me`, then uses it
(Basic `apikey:<token>`) for every OpenProject API call so ACLs and authorship
belong to that person — not a shared service account.

- Fail closed: missing/invalid Bearer → HTTP 401
- Stdio mode still accepts `OPENPROJECT_API_KEY` for local/dev
- Nginx should require a non-empty `Authorization` header and pass it through
  (do not hardcode a single shared `mcp.bearer` allowlist)
- `POST /internal/notify` is loopback-only and requires
  `X-Notify-Token` matching `OPENPROJECT_NOTIFY_TOKEN`. Do not proxy that path.

Per-agent tokens are staged outside this repository, one file per login,
mode 0600. The host and path are recorded in internal operations
documentation.
