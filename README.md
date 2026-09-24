# OpenProject MCP Server

Model Context Protocol (MCP) server for OpenProject API integration. Enables AI assistants to interact with OpenProject work packages, projects, and time tracking.

This CloudBSD fork adds first-class write tools for [status.cloudbsd.org](https://status.cloudbsd.org) against OpenProject API v3.

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

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects |
| `get_work_package` | Get work package details by ID |
| `list_work_packages` | List work packages with filters |
| `get_children` | Get child work packages of a parent |
| `list_statuses` | List all available statuses |
| `list_types` | List all work package types (Feature, Task, Bug, etc.) |
| `get_user` | Get user information |
| `create_work_package` | Create a new work package |
| `update_work_package` | Update an existing work package |
| `log_time` | Log time entry for a work package |
| `raw_api_call` | Make a raw API call to any endpoint |
| `status_upsert` | Create or update a CloudBSD status work package by component/lane |
| `build_annotate` | Attach or update Jenkins build annotation custom fields on a work package |
| `relation_upsert` | Create or ensure a native OpenProject relation (idempotent) |

## Usage Examples

### List Children of a Feature

```javascript
get_children({ parentId: 211 })
```

### Create a New Task

```javascript
create_work_package({
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
  statusId: 12,  // Status ID from list_statuses
  estimatedTime: "PT2H"  // 2 hours in ISO 8601 format
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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENPROJECT_URL` | Yes | OpenProject instance URL. For CloudBSD status writes, use trackdev (DEV). |
| `OPENPROJECT_API_KEY` | Yes | API key from OpenProject |

## Requirements

- Node.js >= 18.0.0
- OpenProject instance with API access

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

Per-agent tokens are staged outside this repository, one file per login,
mode 0600. The host and path are recorded in internal operations
documentation.
