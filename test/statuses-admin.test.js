import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAuthenticityToken,
  resolveWebCredentials,
} from "../lib/web-session.js";
import {
  createStatus,
  updateStatus,
  getStatus,
  findStatusByName,
  STATUS_ADMIN_TOOLS,
} from "../lib/statuses-admin.js";

function withAdmin(apiRequest) {
  return async (path) => {
    if (path === "/api/v3/users/me") return { id: 1, admin: true, login: "admin" };
    return apiRequest(path);
  };
}

test("STATUS_ADMIN_TOOLS registers get/create/update", () => {
  const names = STATUS_ADMIN_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ["create_status", "get_status", "update_status"]);
  for (const tool of STATUS_ADMIN_TOOLS) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 40);
  }
});

test("extractAuthenticityToken reads meta and input forms", () => {
  assert.equal(
    extractAuthenticityToken('<meta name="csrf-token" content="abc123">'),
    "abc123"
  );
  assert.equal(
    extractAuthenticityToken(
      '<input type="hidden" name="authenticity_token" value="tok99" />'
    ),
    "tok99"
  );
  assert.equal(extractAuthenticityToken("<html></html>"), null);
});

test("resolveWebCredentials fails closed without secrets", () => {
  assert.throws(
    () => resolveWebCredentials({}),
    (err) => err.code === "MISSING_WEB_CREDENTIALS"
  );
});

test("resolveWebCredentials reads password file", () => {
  const dir = mkdtempSync(join(tmpdir(), "op-web-"));
  const path = join(dir, "pass");
  writeFileSync(path, "s3cret\n", { mode: 0o600 });
  try {
    const creds = resolveWebCredentials({
      OPENPROJECT_WEB_USER: "mlapointe",
      OPENPROJECT_WEB_PASSWORD_FILE: path,
    });
    assert.equal(creds.username, "mlapointe");
    assert.equal(creds.password, "s3cret");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createStatus is idempotent when name exists", async () => {
  async function apiRequest(path) {
    if (path.startsWith("/api/v3/statuses?pageSize")) {
      return {
        _embedded: {
          elements: [
            { id: 42, name: "PR Ready", isClosed: false, isDefault: false },
          ],
        },
      };
    }
    throw new Error("unexpected " + path);
  }

  const result = await createStatus(
    apiRequest,
    { name: "PR Ready" },
    {
      baseUrl: "https://track.example",
      createSession: () => {
        throw new Error("session should not be used for idempotent hit");
      },
    }
  );

  assert.equal(result.id, 42);
  assert.equal(result.created, false);
  assert.equal(result.idempotent, true);
});

test("createStatus posts admin form then verifies via API", async () => {
  let created = false;
  async function apiRequest(path) {
    if (path.startsWith("/api/v3/statuses?pageSize")) {
      return {
        _embedded: {
          elements: created
            ? [
                {
                  id: 99,
                  name: "PR Ready",
                  isClosed: false,
                  isDefault: false,
                  color: "#74C0FC",
                },
              ]
            : [],
        },
      };
    }
    throw new Error("unexpected " + path);
  }

  const submits = [];
  const result = await createStatus(
    withAdmin(apiRequest),
    { name: "PR Ready", color: "#74C0FC" },
    {
      backend: "web",
      baseUrl: "https://track.example",
      createSession: () => ({
        async submitForm(formPage, action, fields, opts) {
          submits.push({ formPage, action, fields, opts });
          created = true;
          return { status: 302, location: "/statuses" };
        },
      }),
    }
  );

  assert.equal(submits.length, 1);
  assert.equal(submits[0].formPage, "/statuses/new");
  assert.equal(submits[0].action, "/statuses");
  assert.equal(submits[0].fields["status[name]"], "PR Ready");
  assert.equal(result.id, 99);
  assert.equal(result.created, true);
});

test("updateStatus patches via edit form", async () => {
  const status = {
    id: 9,
    name: "In testing",
    isClosed: false,
    isDefault: false,
    color: null,
    defaultDoneRatio: 80,
    position: 11,
  };

  async function apiRequest(path) {
    if (path === "/api/v3/statuses/9") {
      return { ...status };
    }
    throw new Error("unexpected " + path);
  }

  const submits = [];
  const result = await updateStatus(
    withAdmin(apiRequest),
    9,
    { name: "Ready for testing" },
    {
      backend: "web",
      baseUrl: "https://track.example",
      createSession: () => ({
        async submitForm(formPage, action, fields, opts) {
          submits.push({ formPage, action, fields, opts });
          status.name = fields["status[name]"];
          return { status: 302, location: "/statuses" };
        },
      }),
    }
  );

  assert.equal(submits[0].formPage, "/statuses/9/edit");
  assert.equal(submits[0].action, "/statuses/9");
  assert.equal(submits[0].opts.method, "PATCH");
  assert.equal(result.name, "Ready for testing");
  assert.equal(result.previousName, "In testing");
  assert.equal(result.updated, true);
});

test("createStatus rails backend uses runner not web session", async () => {
  async function apiRequest(path) {
    if (path.startsWith("/api/v3/statuses?pageSize")) {
      return { _embedded: { elements: [] } };
    }
    throw new Error("unexpected " + path);
  }

  let sessionUsed = false;
  const result = await createStatus(
    withAdmin(apiRequest),
    { name: "PR Ready" },
    {
      backend: "rails",
      createSession: () => {
        sessionUsed = true;
        throw new Error("web session must not run");
      },
      runRailsCreate: async (attrs) => ({
        id: 18,
        name: attrs.name,
        isClosed: false,
        isDefault: false,
        created: true,
        idempotent: false,
        backend: "rails",
      }),
    }
  );

  assert.equal(sessionUsed, false);
  assert.equal(result.id, 18);
  assert.equal(result.backend, "rails");
  assert.equal(result.created, true);
});

test("getStatus and findStatusByName", async () => {
  async function apiRequest(path) {
    if (path === "/api/v3/statuses/7") {
      return { id: 7, name: "In progress", isClosed: false, isDefault: false };
    }
    if (path.startsWith("/api/v3/statuses?pageSize")) {
      return {
        _embedded: {
          elements: [
            { id: 7, name: "In progress", isClosed: false },
            { id: 16, name: "Done", isClosed: true },
          ],
        },
      };
    }
    throw new Error("unexpected " + path);
  }

  const one = await getStatus(apiRequest, 7);
  assert.equal(one.name, "In progress");
  const found = await findStatusByName(apiRequest, "done");
  assert.equal(found.id, 16);
});

test("web login fails closed on two-factor redirect", async () => {
  const { createWebSession } = await import("../lib/web-session.js");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET" });
    const u = String(url);
    if (u.endsWith("/login") && (!init || init.method === "GET" || !init.method)) {
      return {
        status: 200,
        headers: {
          get: () => null,
          getSetCookie: () => [],
        },
        text: async () =>
          '<meta name="csrf-token" content="tok"><input name="authenticity_token" value="tok"/>',
      };
    }
    if (u.endsWith("/login") && init?.method === "POST") {
      return {
        status: 302,
        headers: {
          get: (h) =>
            h.toLowerCase() === "location"
              ? "https://track.example/two_factor_authentication/request"
              : null,
          getSetCookie: () => ["_open_project_session=abc"],
        },
        text: async () => "",
      };
    }
    throw new Error("unexpected fetch " + u);
  };

  const session = createWebSession({
    baseUrl: "https://track.example",
    fetchImpl,
    getCredentials: () => ({ username: "u", password: "p", source: "test" }),
  });

  await assert.rejects(
    () => session.ensureLogin(),
    (err) => err.code === "LOGIN_REQUIRES_2FA"
  );
});
