import test from "node:test";
import assert from "node:assert/strict";
import { COMMENT_TOOLS, handleCommentTool } from "../lib/comments.js";
import { WP_UPDATE_TOOLS, handleWpUpdateTool } from "../lib/wp-update.js";
import { fakeApi, httpError, STATUSES, workPackage, applyPatch, collection } from "./fake-op.js";

const OPTIONS = { baseUrl: "https://op.example.invalid/" };
const TITLES = {
  "/api/v3/statuses/1": "New",
  "/api/v3/statuses/2": "In progress",
  "/api/v3/statuses/3": "Blocked",
  "/api/v3/statuses/4": "Done",
};

const update = (args, request) => handleWpUpdateTool("update_work_package", args, request, OPTIONS);

function activity(id, comment, extra) {
  return {
    _type: "Activity::Comment",
    id,
    createdAt: "2026-10-0" + id + "T10:00:00Z",
    comment: { format: "markdown", raw: comment },
    details: (extra && extra.details) || [],
    _links: {
      user: { href: "/api/v3/users/7", title: "Mark LaPointe" },
      workPackage: { href: "/api/v3/work_packages/1677" },
    },
  };
}

/** A work package store that answers GET and PATCH like OpenProject. */
function wpRoutes(state) {
  return [
    { method: "GET", path: "/api/v3/statuses", reply: STATUSES },
    {
      method: "GET",
      path: "/api/v3/work_packages/1677",
      reply: () => state.wp,
    },
    {
      method: "PATCH",
      path: "/api/v3/work_packages/1677",
      reply: ({ body }) => {
        if (state.patchError) {
          const error = state.patchError;
          state.patchError = state.patchErrorOnce ? null : state.patchError;
          if (state.onConflict) state.onConflict(state);
          throw error;
        }
        state.wp = applyPatch(state.wp, body, TITLES);
        return state.wp;
      },
    },
  ];
}

test("every new tool schema refuses additional properties", () => {
  for (const tool of [...COMMENT_TOOLS, ...WP_UPDATE_TOOLS]) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
  assert.deepEqual(
    WP_UPDATE_TOOLS.map((tool) => tool.name),
    ["get_work_package", "update_work_package", "set_status", "validate_update"]
  );
  assert.deepEqual(
    COMMENT_TOOLS.map((tool) => tool.name),
    ["add_comment", "list_activities", "edit_comment"]
  );
});

test("update_work_package refuses unknown arguments with accepted names and did-you-mean", async () => {
  const { request, calls } = fakeApi([]);
  await assert.rejects(
    () => update({ id: 1677, staus: "Done" }, request),
    (error) => {
      assert.match(error.message, /Unknown argument.*"staus"/);
      assert.match(error.message, /did you mean "status"\?/);
      assert.match(error.message, /Accepted: .*statusId/);
      return true;
    }
  );
  assert.equal(calls.length, 0, "nothing is sent when arguments are refused");
});

test("unknown names that look like nothing get no suggestion", async () => {
  const { request } = fakeApi([]);
  await assert.rejects(
    () => update({ id: 1677, zzzzzzzz: 1 }, request),
    (error) => !/did you mean/.test(error.message) && /zzzzzzzz/.test(error.message)
  );
});

test("a known key whose value is null is treated as absent; workPackageId alias works", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(wpRoutes(state));
  await update({ workPackageId: 1677, subject: "Renamed", assigneeId: null, status: null }, request);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { lockVersion: 5, subject: "Renamed" });
});

test("status by name (case-insensitive) resolves to an id and the result is compact", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(wpRoutes(state));
  const result = await update({ id: 1677, status: "in PROGRESS" }, request);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(patch.path, "/api/v3/work_packages/1677");
  assert.deepEqual(patch.body._links.status, { href: "/api/v3/statuses/2" });
  assert.equal(patch.body.lockVersion, 5);
  assert.deepEqual(result.status, { id: 2, name: "In progress" });
  assert.equal(result.lockVersion, 6);
  assert.equal(result.updatedAt, "2026-10-31T12:00:00Z");
  assert.deepEqual(result.project, { id: 3, identifier: "cloudbsd", name: "CloudBSD" });
  assert.equal(result.url, "https://op.example.invalid/work_packages/1677");
  assert.equal(result.retried, false);
  assert.equal(result._links, undefined, "never the whole echo");
});

test("an unknown status name is an error listing the valid names", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(wpRoutes(state));
  await assert.rejects(
    () => update({ id: 1677, status: "Shipped" }, request),
    /Unknown status "Shipped".*New, In progress, Blocked, Done/
  );
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("falsy values are written, and clear empties a field (no truthiness checks)", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(wpRoutes(state));
  await update(
    { id: 1677, percentageDone: 0, scheduleManually: false, clear: ["parentId", "dueDate", "description"] },
    request
  );
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(patch.body.percentageDone, 0);
  assert.deepEqual(patch.body.description, { format: "markdown", raw: "" });
  assert.equal(patch.body.scheduleManually, false);
  assert.deepEqual(patch.body._links.parent, { href: null });
  assert.equal(patch.body.dueDate, null);
});

test("ids are validated before anything is put into a path", async () => {
  const { request, calls } = fakeApi([]);
  await assert.rejects(() => update({ id: "../projects/1", subject: "x" }, request), /id must be a positive integer/);
  await assert.rejects(
    () => handleWpUpdateTool("get_work_package", { id: "1677?x=1" }, request, OPTIONS),
    /id must be a positive integer/
  );
  assert.equal(calls.length, 0);
});

test("a 422 on a status change carries allowedStatuses from /form", async () => {
  const state = {
    wp: workPackage(),
    patchError: httpError(422, {
      _type: "Error",
      errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
      message: "Status is invalid because no valid transition exists from old to new status for the current user's roles.",
    }),
  };
  const routes = [
    ...wpRoutes(state),
    {
      method: "POST",
      path: "/api/v3/work_packages/1677/form",
      reply: {
        _type: "Form",
        _embedded: {
          payload: {},
          schema: {
            status: {
              _embedded: {
                allowedValues: [
                  { id: 1, name: "New", _links: {} },
                  { id: 3, name: "Blocked", _links: {} },
                ],
              },
            },
          },
          validationErrors: {},
        },
      },
    },
  ];
  const { request, calls } = fakeApi(routes);
  await assert.rejects(
    () => update({ id: 1677, status: "Done" }, request),
    (error) => {
      assert.match(error.message, /no valid transition exists/);
      assert.match(error.message, /Blocked/);
      assert.deepEqual(error.allowedStatuses, [
        { id: 1, name: "New" },
        { id: 3, name: "Blocked" },
      ]);
      return true;
    }
  );
  const form = calls.find((c) => c.path === "/api/v3/work_packages/1677/form");
  assert.ok(form, "posted the proposed body to /form");
  assert.equal(form.method, "POST");
  assert.deepEqual(form.body._links.status, { href: "/api/v3/statuses/4" });
});

test("a 422 that is not about status reports the OpenProject message without /form", async () => {
  const state = { wp: workPackage(), patchError: httpError(422, { message: "Due date must be after start date." }) };
  const { request, calls } = fakeApi(wpRoutes(state));
  await assert.rejects(() => update({ id: 1677, dueDate: "2020-01-01" }, request), /Due date must be after start date/);
  assert.equal(calls.some((c) => c.path.includes("/form")), false);
});

test("409: re-reads and retries once when no written field changed", async () => {
  const state = {
    wp: workPackage(),
    patchError: httpError(409, { message: "Couldn't update the resource because of conflicting modifications." }),
    patchErrorOnce: true,
    onConflict: (s) => {
      // someone else changed an unrelated field
      s.wp = { ...s.wp, lockVersion: 6, percentageDone: 50 };
    },
  };
  const { request, calls } = fakeApi(wpRoutes(state));
  const result = await update({ id: 1677, subject: "New subject" }, request);
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 2);
  assert.equal(patches[0].body.lockVersion, 5);
  assert.equal(patches[1].body.lockVersion, 6);
  assert.equal(result.retried, true);
  assert.equal(result.subject, "New subject");
});

test("409: no retry when the caller passed lockVersion", async () => {
  const state = { wp: workPackage(), patchError: httpError(409, { message: "conflict" }) };
  const { request, calls } = fakeApi(wpRoutes(state));
  await assert.rejects(
    () => update({ id: 1677, subject: "x", lockVersion: 5 }, request),
    (error) => error.code === "UPDATE_CONFLICT"
  );
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(calls.filter((c) => c.method === "GET" && c.path === "/api/v3/work_packages/1677").length, 0);
});

test("409: conflict (no retry) when a field being written changed between reads", async () => {
  const state = {
    wp: workPackage(),
    patchError: httpError(409, { message: "conflict" }),
    patchErrorOnce: true,
    onConflict: (s) => {
      s.wp = { ...s.wp, lockVersion: 6, subject: "Someone else's subject" };
    },
  };
  const { request, calls } = fakeApi(wpRoutes(state));
  await assert.rejects(
    () => update({ id: 1677, subject: "Mine" }, request),
    (error) => {
      assert.equal(error.code, "UPDATE_CONFLICT");
      assert.match(error.message, /subject/);
      return true;
    }
  );
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
});

test("comment is posted after a successful PATCH, with notify=false on both", async () => {
  const state = { wp: workPackage() };
  const routes = [
    ...wpRoutes(state),
    {
      method: "POST",
      path: "/api/v3/work_packages/1677/activities",
      reply: activity(9, "moving on"),
    },
  ];
  const { request, calls } = fakeApi(routes);
  const result = await update({ id: 1677, status: "In progress", comment: "moving on", notify: false }, request);
  const patchAt = calls.findIndex((c) => c.method === "PATCH");
  const postAt = calls.findIndex((c) => c.method === "POST");
  assert.ok(patchAt >= 0 && postAt > patchAt, "PATCH first, then the comment");
  assert.equal(calls[patchAt].path, "/api/v3/work_packages/1677?notify=false");
  assert.equal(calls[postAt].path, "/api/v3/work_packages/1677/activities?notify=false");
  assert.deepEqual(calls[postAt].body, { comment: { raw: "moving on" } });
  assert.equal(result.commentId, 9);
});

test("a comment failure after a successful PATCH returns success with comment.error", async () => {
  const state = { wp: workPackage() };
  const routes = [
    ...wpRoutes(state),
    {
      method: "POST",
      path: "/api/v3/work_packages/1677/activities",
      reply: () => {
        throw httpError(403, { message: "You are not authorized to access this resource." });
      },
    },
  ];
  const { request } = fakeApi(routes);
  const result = await update({ id: 1677, status: "In progress", comment: "hi" }, request);
  assert.deepEqual(result.status, { id: 2, name: "In progress" });
  assert.match(result.comment.error, /not authorized/);
  assert.equal(result.commentId, undefined);
});

test("a status that OpenProject did not apply is an error", async () => {
  const state = { wp: workPackage() };
  const routes = [
    { method: "GET", path: "/api/v3/statuses", reply: STATUSES },
    { method: "GET", path: "/api/v3/work_packages/1677", reply: () => state.wp },
    { method: "PATCH", path: "/api/v3/work_packages/1677", reply: () => ({ ...state.wp, lockVersion: 6 }) },
  ];
  const { request } = fakeApi(routes);
  await assert.rejects(() => update({ id: 1677, statusId: 4 }, request), /status is still New/);
});

test("set_status is a wrapper over the same update path", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(wpRoutes(state));
  const result = await handleWpUpdateTool("set_status", { id: 1677, status: "Blocked", percentageDone: 20 }, request, OPTIONS);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body._links.status, { href: "/api/v3/statuses/3" });
  assert.equal(patch.body.percentageDone, 20);
  assert.deepEqual(result.status, { id: 3, name: "Blocked" });
  await assert.rejects(
    () => handleWpUpdateTool("set_status", { id: 1677, subject: "no" }, request, OPTIONS),
    /Unknown argument.*"subject"/
  );
  await assert.rejects(
    () => handleWpUpdateTool("set_status", { id: 1677 }, request, OPTIONS),
    /status or statusId/
  );
});

test("validate_update posts to /form only and reports errors, allowed statuses and resulting dates", async () => {
  const state = { wp: workPackage() };
  const routes = [
    ...wpRoutes(state),
    {
      method: "POST",
      path: "/api/v3/work_packages/1677/form",
      reply: {
        _type: "Form",
        _embedded: {
          payload: { startDate: "2026-11-01", dueDate: "2026-10-01", derivedStartDate: null, derivedDueDate: "2026-12-01" },
          schema: { status: { _embedded: { allowedValues: [{ id: 2, name: "In progress" }] } } },
          validationErrors: {
            dueDate: { _type: "Error", message: "Finish date must be after start date.", _embedded: { details: { attribute: "dueDate" } } },
          },
        },
      },
    },
  ];
  const { request, calls } = fakeApi(routes);
  const result = await handleWpUpdateTool(
    "validate_update",
    { id: 1677, startDate: "2026-11-01", status: "In progress" },
    request,
    OPTIONS
  );
  assert.deepEqual(result, {
    valid: false,
    errors: [{ attribute: "dueDate", message: "Finish date must be after start date." }],
    allowedStatuses: [{ id: 2, name: "In progress" }],
    resulting: { startDate: "2026-11-01", dueDate: "2026-10-01", derivedStartDate: null, derivedDueDate: "2026-12-01" },
  });
  assert.equal(calls.some((c) => c.method === "PATCH"), false);
  const form = calls.find((c) => c.path.endsWith("/form"));
  assert.equal(form.body.startDate, "2026-11-01");
  assert.equal(form.body.lockVersion, 5);
});

test("get_work_package returns compact links, project, url, ancestors and childIds; comments opt-in", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(wpRoutes(state));
  const result = await handleWpUpdateTool("get_work_package", { id: 1677 }, request, OPTIONS);
  assert.deepEqual(result.status, { id: 1, name: "New" });
  assert.deepEqual(result.type, { id: 4, name: "Ops" });
  assert.deepEqual(result.priority, { id: 8, name: "Normal" });
  assert.equal(result.assignee, null);
  assert.deepEqual(result.parent, { id: 1600, name: "Track MCP" });
  assert.equal(result.parentId, 1600);
  assert.deepEqual(result.project, { id: 3, identifier: "cloudbsd", name: "CloudBSD" });
  assert.deepEqual(result.ancestors, [
    { id: 1500, name: "Root" },
    { id: 1600, name: "Track MCP" },
  ]);
  assert.deepEqual(result.childIds, [1678]);
  assert.equal(result.lockVersion, 5);
  assert.equal(result.updatedAt, "2026-10-30T10:00:00Z");
  assert.equal(result.url, "https://op.example.invalid/work_packages/1677");
  assert.equal(result.description, "desc");
  assert.equal(result.scheduleManually, false);
  assert.equal(result.comments, undefined);
  assert.equal(calls.length, 1, "no activities call unless includeComments");
});

test("get_work_package includeComments returns the last N comments, capped at 50", async () => {
  const state = { wp: workPackage() };
  const routes = [
    ...wpRoutes(state),
    {
      method: "GET",
      path: "/api/v3/work_packages/1677/activities",
      reply: collection([activity(1, "first"), activity(2, ""), activity(3, "third"), activity(4, "fourth")]),
    },
  ];
  const { request, calls } = fakeApi(routes);
  const result = await handleWpUpdateTool("get_work_package", { id: 1677, includeComments: 2 }, request, OPTIONS);
  assert.deepEqual(result.comments.map((c) => c.comment), ["fourth", "third"]);
  await handleWpUpdateTool("get_work_package", { id: 1677, includeComments: 5000 }, request, OPTIONS);
  const last = calls.filter((c) => c.path.includes("/activities")).pop();
  assert.match(last.path, /pageSize=50\b/);
});

test("add_comment posts the raw comment and returns only the compact ids", async () => {
  const { request, calls } = fakeApi([
    { method: "POST", path: "/api/v3/work_packages/1677/activities", reply: activity(9, "see #1600") },
  ]);
  const result = await handleCommentTool("add_comment", { id: 1677, comment: "see #1600" }, request, OPTIONS);
  assert.deepEqual(result, { activityId: 9, workPackageId: 1677, createdAt: "2026-10-09T10:00:00Z" });
  assert.deepEqual(calls[0].body, { comment: { raw: "see #1600" } });
  assert.equal(calls[0].path, "/api/v3/work_packages/1677/activities");
  assert.match(COMMENT_TOOLS[0].description, /#NNN/);
  await assert.rejects(
    () => handleCommentTool("add_comment", { id: 1677 }, request, OPTIONS),
    /comment is required/
  );
});

test("add_comment notify=false goes on the query", async () => {
  const { request, calls } = fakeApi([
    { method: "POST", path: "/api/v3/work_packages/1677/activities", reply: activity(9, "x") },
  ]);
  await handleCommentTool("add_comment", { workPackageId: 1677, comment: "x", notify: false }, request, OPTIONS);
  assert.equal(calls[0].path, "/api/v3/work_packages/1677/activities?notify=false");
});

test("list_activities orders, filters to comments and truncates long comments", async () => {
  const long = "x".repeat(2500);
  const { request, calls } = fakeApi([
    {
      method: "GET",
      path: "/api/v3/work_packages/1677/activities",
      reply: collection([
        activity(1, "first"),
        activity(2, "", { details: [{ format: "custom", raw: "Status changed from New to In progress" }] }),
        activity(3, long),
      ]),
    },
  ]);
  const desc = await handleCommentTool("list_activities", { id: 1677 }, request, OPTIONS);
  assert.match(calls[0].path, /pageSize=20/);
  assert.deepEqual(desc.elements.map((a) => a.id), [3, 2, 1]);
  assert.equal(desc.total, 3);
  assert.deepEqual(desc.elements[1].changes, ["Status changed from New to In progress"]);
  assert.deepEqual(desc.elements[0].user, { id: 7, name: "Mark LaPointe" });
  assert.equal(desc.elements[0].truncated, true);
  assert.ok(desc.elements[0].comment.length < 2100);
  assert.match(desc.elements[0].comment, /truncated.*2500/);

  const asc = await handleCommentTool(
    "list_activities",
    { id: 1677, order: "asc", commentsOnly: true, limit: 1 },
    request,
    OPTIONS
  );
  assert.deepEqual(asc.elements.map((a) => a.id), [1]);
  assert.equal(asc.hasMore, true);
});

test("edit_comment patches the activity", async () => {
  const { request, calls } = fakeApi([
    { method: "PATCH", path: "/api/v3/activities/9", reply: { ...activity(9, "fixed"), updatedAt: "2026-10-31T00:00:00Z" } },
  ]);
  const result = await handleCommentTool("edit_comment", { activityId: 9, comment: "fixed" }, request, OPTIONS);
  assert.deepEqual(calls[0].body, { comment: { raw: "fixed" } });
  assert.equal(result.activityId, 9);
  assert.equal(result.workPackageId, 1677);
});

test("handlers return undefined for tools they do not own", async () => {
  const { request } = fakeApi([]);
  assert.equal(await handleCommentTool("list_projects", {}, request, OPTIONS), undefined);
  assert.equal(await handleWpUpdateTool("list_projects", {}, request, OPTIONS), undefined);
});
