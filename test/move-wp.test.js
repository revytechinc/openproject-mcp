/**
 * update_work_package / validate_update: move a work package to another
 * project (projectId) and set or clear its parent (parentId, null clears).
 * Track #1910.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { WP_UPDATE_TOOLS, handleWpUpdateTool } from "../lib/wp-update.js";
import { fakeApi, httpError, collection, workPackage, applyPatch } from "./fake-op.js";

const OPTIONS = { baseUrl: "https://op.example.invalid/" };
const TITLES = {
  "/api/v3/projects/3": "CloudBSD",
  "/api/v3/projects/5": "Desktop",
  "/api/v3/work_packages/1700": "New parent",
};
const update = (args, request) => handleWpUpdateTool("update_work_package", args, request, OPTIONS);
const validate = (args, request) => handleWpUpdateTool("validate_update", args, request, OPTIONS);

const DESKTOP = { _type: "Project", id: 5, identifier: "desktop", name: "Desktop", _links: {} };
const OPS_AND_TASK = collection([
  { id: 1, name: "Task" },
  { id: 4, name: "Ops" },
]);
const TASK_AND_BUG = collection([
  { id: 1, name: "Task" },
  { id: 5, name: "Bug" },
]);

/** A work package store with a project lookup, its types and one child. */
function moveRoutes(state) {
  return [
    { method: "GET", path: /^\/api\/v3\/projects\/(desktop|5)$/, reply: DESKTOP },
    { method: "GET", path: "/api/v3/projects/5/types", reply: () => state.types || OPS_AND_TASK },
    { method: "GET", path: "/api/v3/work_packages/1677", reply: () => state.wp },
    {
      method: "GET",
      path: "/api/v3/work_packages/1678",
      reply: () => {
        if (state.childError) throw state.childError;
        return workPackage({
          id: 1678,
          subject: "Child",
          _links: { project: { href: state.childProject || "/api/v3/projects/5", title: "Desktop" }, children: [] },
        });
      },
    },
    {
      method: "PATCH",
      path: "/api/v3/work_packages/1677",
      reply: ({ body }) => {
        if (state.patchError) throw state.patchError;
        state.wp = applyPatch(state.wp, body, TITLES);
        if (body._links && body._links.project) state.wp._embedded = {};
        return state.wp;
      },
    },
    { method: "POST", path: "/api/v3/work_packages/1677/form", reply: ({ body }) => state.form(body) },
  ];
}

/** A /form answer with no errors. */
const emptyForm = () => ({ _embedded: { payload: {}, validationErrors: {}, schema: {} } });

/** moveRoutes with the PATCH answer changed by tweak(next) after the patch is applied. */
function patchedRoutes(state, tweak) {
  const routes = moveRoutes(state);
  routes.find((r) => r.method === "PATCH").reply = ({ body }) => {
    const next = applyPatch(state.wp, body, TITLES);
    tweak(next);
    return next;
  };
  return routes;
}

/** moveRoutes whose first PATCH answers 409 after change(state) moved the work package on. */
function conflictOnceRoutes(state, change) {
  let conflicts = 1;
  const routes = moveRoutes(state);
  routes.find((r) => r.method === "PATCH").reply = ({ body }) => {
    if (conflicts-- > 0) {
      change(state);
      throw httpError(409, { message: "conflict" });
    }
    state.wp = applyPatch(state.wp, body, TITLES);
    return state.wp;
  };
  return routes;
}

/** A parent with n children (ids 2000...), every child already in Desktop. */
function manyChildren(n) {
  const kids = Array.from({ length: n }, (_, i) => ({ href: "/api/v3/work_packages/" + (2000 + i), title: "Kid " + i }));
  const state = { wp: workPackage({ _links: { children: kids } }) };
  const routes = [
    {
      method: "GET",
      path: /^\/api\/v3\/work_packages\/2\d{3}$/,
      reply: ({ endpoint }) =>
        workPackage({ id: Number(endpoint.split("/").pop()), _links: { project: { href: "/api/v3/projects/5" } } }),
    },
    ...moveRoutes(state),
  ];
  return fakeApi(routes);
}

test("update_work_package and validate_update take projectId and a nullable parentId", () => {
  for (const name of ["update_work_package", "validate_update"]) {
    const tool = WP_UPDATE_TOOLS.find((t) => t.name === name);
    const props = tool.inputSchema.properties;
    assert.ok(props.projectId, name + " has projectId");
    assert.match(props.projectId.description, /type/i, "the description warns about the type rule");
    assert.equal(props.projectId.type, "string", "no union types (review-1677 item 10)");
    assert.match(props.parentId.description, /clear: \["parentId"\].*parentId: null/, name + " documents both ways to remove the parent");
  }
});

test("projectId by identifier moves the work package through PATCH with lockVersion", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { lockVersion: 5, _links: { project: { href: "/api/v3/projects/5" } } });
  assert.deepEqual(result.project, { id: 5, name: "Desktop" });
  assert.deepEqual(result.moved, {
    from: { id: 3, name: "CloudBSD", identifier: "cloudbsd" },
    to: { id: 5, identifier: "desktop", name: "Desktop" },
  });
  assert.deepEqual(result.type, { id: 4, name: "Ops" }, "the type is unchanged");
  assert.equal(
    calls.filter((c) => c.method === "GET" && c.path === "/api/v3/work_packages/1677").length,
    1,
    "the work package is read once for the type check and the lockVersion"
  );
});

test("projectId as a number is accepted", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(moveRoutes(state));
  await update({ id: 1677, projectId: 5 }, request);
  assert.deepEqual(calls.find((c) => c.method === "PATCH").body._links.project, { href: "/api/v3/projects/5" });
});

test("a move reports the children OpenProject moved with the parent", async () => {
  const state = { wp: workPackage() };
  const { request } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.deepEqual(result.children, { moved: [{ id: 1678, subject: "Child" }], notMoved: [], unknown: [] });
  assert.equal(result.childrenNote, undefined);
});

test("a move says which children stayed behind when OpenProject did not move them", async () => {
  const state = { wp: workPackage(), childProject: "/api/v3/projects/3" };
  const { request } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.deepEqual(result.children, { moved: [], notMoved: [{ id: 1678, subject: "Child" }], unknown: [] });
  assert.match(result.childrenNote, /left in other projects \(target was Desktop\): 1678/i);
  assert.match(result.childrenNote, /If they belong in Desktop, move each with update_work_package projectId: "desktop"/);
});

test("a child that cannot be read is reported as unknown, not as moved", async () => {
  const state = { wp: workPackage(), childError: httpError(403, { message: "not allowed" }) };
  const { request } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.deepEqual(result.children, { moved: [], notMoved: [], unknown: [{ id: 1678, subject: "Child" }] });
  assert.match(result.childrenNote, /could not be read: 1678 \(Child\)/);
  assert.doesNotMatch(result.childrenNote, /move each/, "no move advice for a child whose location is unknown");
});

test("a work package with no children has no children report", async () => {
  const state = { wp: workPackage({ _links: { children: [] } }) };
  const { request } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.equal(result.children, undefined);
});

test("a move to a project where the type is not enabled fails before the PATCH", async () => {
  const state = { wp: workPackage(), types: TASK_AND_BUG };
  const { request, calls } = fakeApi(moveRoutes(state));
  await assert.rejects(
    () => update({ id: 1677, projectId: "desktop" }, request),
    (error) => {
      assert.equal(error.code, "TYPE_NOT_ENABLED");
      assert.match(error.message, /type "Ops" is not enabled in project Desktop \(desktop\)/);
      assert.match(error.message, /Task \(1\), Bug \(5\)/);
      assert.match(error.message, /does not change the type for you/);
      assert.deepEqual(error.allowedTypes, [
        { id: 1, name: "Task" },
        { id: 5, name: "Bug" },
      ]);
      return true;
    }
  );
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("the type check also runs when the caller passes lockVersion", async () => {
  const state = { wp: workPackage(), types: TASK_AND_BUG };
  const { request, calls } = fakeApi(moveRoutes(state));
  await assert.rejects(() => update({ id: 1677, projectId: 5, lockVersion: 5 }, request), /not enabled/);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("a type OpenProject changed during the move anyway is reported as an error", async () => {
  const state = { wp: workPackage() };
  const { request } = fakeApi(patchedRoutes(state, (next) => (next._links.type = { href: "/api/v3/types/1", title: "Task" })));
  await assert.rejects(
    () => update({ id: 1677, projectId: "desktop" }, request),
    (error) => {
      assert.equal(error.code, "TYPE_CHANGED");
      assert.match(error.message, /^The update was applied to work package 1677\. It is now in Desktop, but OpenProject changed its type from Ops to Task\. Do not repeat the move/);
      return true;
    }
  );
});

test("an unsafe projectId is refused before anything is sent", async () => {
  const { request, calls } = fakeApi([]);
  await assert.rejects(() => update({ id: 1677, projectId: "../users/1" }, request), /projectId must be a project id/);
  assert.equal(calls.length, 0);
});

test("a 422 from OpenProject on a move keeps its message", async () => {
  const state = { wp: workPackage(), patchError: httpError(422, { message: "Version is not valid." }) };
  const { request } = fakeApi(moveRoutes(state));
  await assert.rejects(() => update({ id: 1677, projectId: "desktop" }, request), /Version is not valid/);
});

test("parentId null clears the parent", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, parentId: null }, request);
  assert.deepEqual(calls.find((c) => c.method === "PATCH").body, { lockVersion: 5, _links: { parent: { href: null } } });
  assert.equal(result.parentId, null);
});

test("parentId null together with clear parentId is one clear, not an error", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(moveRoutes(state));
  await update({ id: 1677, parentId: null, clear: ["parentId", "dueDate"] }, request);
  const body = calls.find((c) => c.method === "PATCH").body;
  assert.deepEqual(body._links.parent, { href: null });
  assert.equal(body.dueDate, null);
});

test("parentId as a number sets the parent, and moves with projectId in one PATCH", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop", parentId: 1700 }, request);
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].body._links, {
    project: { href: "/api/v3/projects/5" },
    parent: { href: "/api/v3/work_packages/1700" },
  });
  assert.equal(result.parentId, 1700);
});

test("validate_update with projectId posts the move to /form only", async () => {
  const state = {
    wp: workPackage(),
    form: emptyForm,
  };
  const { request, calls } = fakeApi(moveRoutes(state));
  const result = await validate({ id: 1677, projectId: "desktop", parentId: null }, request);
  const form = calls.find((c) => c.path.endsWith("/form"));
  assert.deepEqual(form.body._links, { project: { href: "/api/v3/projects/5" }, parent: { href: null } });
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(result.valid, true);
});

test("validate_update reports a type that is not enabled in the target project", async () => {
  const state = {
    wp: workPackage(),
    types: TASK_AND_BUG,
    form: emptyForm,
  };
  const { request, calls } = fakeApi(moveRoutes(state));
  const result = await validate({ id: 1677, projectId: "desktop" }, request);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].attribute, "type");
  assert.match(result.errors[0].message, /not enabled in project Desktop/);
  assert.equal(calls.filter((c) => c.path.endsWith("/form")).length, 0, "no /form when the move cannot work");
});

test("set_status does not take projectId", () => {
  const tool = WP_UPDATE_TOOLS.find((t) => t.name === "set_status");
  assert.equal(tool.inputSchema.properties.projectId, undefined);
});

test("the move error codes carry hints in the structured tool error", async () => {
  const { toolErrorObject } = await import("../lib/errors.js");
  const notEnabled = toolErrorObject({ code: "TYPE_NOT_ENABLED", message: "x", allowedTypes: [{ id: 1, name: "Task" }] });
  assert.match(notEnabled.hint, /enable|type/i);
  assert.deepEqual(notEnabled.allowedTypes, [{ id: 1, name: "Task" }]);
  assert.match(toolErrorObject({ code: "TYPE_CHANGED", message: "x" }).hint, /type/i);
  assert.match(toolErrorObject({ code: "MOVE_NOT_APPLIED", message: "x" }).hint, /target project/);
});

test("a child whose project link cannot be read is unknown, not 'not moved'", async () => {
  const state = { wp: workPackage(), childProject: null };
  const routes = moveRoutes(state);
  routes.find((r) => r.path === "/api/v3/work_packages/1678").reply = () =>
    workPackage({ id: 1678, subject: "Child", _links: { project: { href: null }, children: [] } });
  const { request } = fakeApi(routes);
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.deepEqual(result.children, { moved: [], notMoved: [], unknown: [{ id: 1678, subject: "Child" }] });
});

test("the children come from the pre-move read when the PATCH answer has no children list", async () => {
  const state = { wp: workPackage() };
  const { request } = fakeApi(patchedRoutes(state, (next) => delete next._links.children));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.deepEqual(result.children.moved, [{ id: 1678, subject: "Child" }]);
});

test("at most 50 children are read back; the rest are reported unknown", async () => {
  const { request, calls } = manyChildren(52);
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.equal(result.children.moved.length, 50);
  assert.deepEqual(result.children.unknown, [
    { id: 2050, subject: "Kid 50" },
    { id: 2051, subject: "Kid 51" },
  ]);
  assert.equal(calls.filter((c) => /work_packages\/2\d{3}$/.test(c.path)).length, 50);
});

test("a move to the project it is already in writes nothing and says so", async () => {
  const state = { wp: workPackage({ _links: { project: { href: "/api/v3/projects/5", title: "Desktop" } } }) };
  const { request, calls } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(result.moved, undefined);
  assert.equal(result.projectNote, "Already in project Desktop; not moved.");
});

test("a move to the same project together with another field still writes that field, without a project link", async () => {
  const state = { wp: workPackage({ _links: { project: { href: "/api/v3/projects/5", title: "Desktop" } } }) };
  const { request, calls } = fakeApi(moveRoutes(state));
  await update({ id: 1677, projectId: 5, subject: "Renamed" }, request);
  assert.deepEqual(calls.find((c) => c.method === "PATCH").body, { lockVersion: 5, subject: "Renamed" });
});

test("a work package whose type cannot be read is not moved (fail closed)", async () => {
  const state = { wp: workPackage({ _links: { type: { href: null } } }) };
  const { request, calls } = fakeApi(moveRoutes(state));
  await assert.rejects(
    () => update({ id: 1677, projectId: "desktop" }, request),
    (error) => error.code === "TYPE_UNKNOWN" && /could not be read/.test(error.message)
  );
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("a PATCH that leaves the work package in its old project is an error that says the update was applied", async () => {
  const state = { wp: workPackage() };
  const routes = patchedRoutes(state, (next) => (next._links.project = { href: "/api/v3/projects/3", title: "CloudBSD" }));
  const { request } = fakeApi(routes);
  await assert.rejects(
    () => update({ id: 1677, projectId: "desktop", comment: "moving" }, request),
    (error) => {
      assert.equal(error.code, "MOVE_NOT_APPLIED");
      assert.match(error.message, /^The update was applied to work package 1677; the comment was not posted\. But it is not in project Desktop: it is still in project CloudBSD/);
      return true;
    }
  );
});

test("a type missing from the PATCH answer is MOVE_UNVERIFIED, not kept", async () => {
  const state = { wp: workPackage() };
  const { request } = fakeApi(patchedRoutes(state, (next) => (next._links.type = { href: null })));
  await assert.rejects(() => update({ id: 1677, projectId: "desktop" }, request), /type could not be read from the answer/);
});

test("409 on a move: no retry when the type changed meanwhile", async () => {
  const state = { wp: workPackage() };
  const routes = conflictOnceRoutes(state, (st) => {
    st.wp = { ...st.wp, lockVersion: 6, _links: { ...st.wp._links, type: { href: "/api/v3/types/5", title: "Bug" } } };
  });
  const { request, calls } = fakeApi(routes);
  await assert.rejects(
    () => update({ id: 1677, projectId: "desktop" }, request),
    (error) => error.code === "UPDATE_CONFLICT" && /type/.test(error.message)
  );
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
});

test("409 on a move: retried once when nothing it checked changed", async () => {
  const state = { wp: workPackage() };
  const routes = conflictOnceRoutes(state, (st) => {
    st.wp = { ...st.wp, lockVersion: 6, percentageDone: 50 };
  });
  const { request } = fakeApi(routes);
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.equal(result.retried, true);
  assert.equal(result.moved.to.id, 5);
});

test("a move with a comment posts the comment after the move", async () => {
  const state = { wp: workPackage() };
  const routes = [
    ...moveRoutes(state),
    { method: "POST", path: "/api/v3/work_packages/1677/activities", reply: { id: 99, _type: "Activity::Comment" } },
  ];
  const { request, calls } = fakeApi(routes);
  const result = await update({ id: 1677, projectId: "desktop", comment: "Moved" }, request);
  const patchAt = calls.findIndex((c) => c.method === "PATCH");
  const postAt = calls.findIndex((c) => c.path.startsWith("/api/v3/work_packages/1677/activities"));
  assert.ok(patchAt >= 0 && postAt > patchAt);
  assert.equal(result.commentId, 99);
  assert.equal(result.moved.to.id, 5);
});

test("validate_update returns allowedTypes for a type that is not enabled", async () => {
  const state = { wp: workPackage(), types: TASK_AND_BUG };
  const { request } = fakeApi(moveRoutes(state));
  const result = await validate({ id: 1677, projectId: "desktop" }, request);
  assert.deepEqual(result.allowedTypes, [
    { id: 1, name: "Task" },
    { id: 5, name: "Bug" },
  ]);
});

test("validate_update for the project it is already in sends no project link", async () => {
  const state = {
    wp: workPackage({ _links: { project: { href: "/api/v3/projects/5", title: "Desktop" } } }),
    form: emptyForm,
  };
  const { request, calls } = fakeApi(moveRoutes(state));
  await validate({ id: 1677, projectId: "desktop", subject: "x" }, request);
  assert.equal(calls.find((c) => c.path.endsWith("/form")).body._links, undefined);
});

test("set_status does not promise the move fields", () => {
  const tool = WP_UPDATE_TOOLS.find((t) => t.name === "set_status");
  assert.doesNotMatch(tool.description, /moved|children/);
  const updateTool = WP_UPDATE_TOOLS.find((t) => t.name === "update_work_package");
  assert.match(updateTool.description, /projectId to move it/);
  assert.match(updateTool.description, /children:\{moved,notMoved,unknown\}/);
});

test("over 50 children: the note says which were not checked, apart from unreadable ones", async () => {
  const { request } = manyChildren(51);
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.match(result.childrenNote, /not checked \(more than 50 children\): 2050 \(Kid 50\)/);
});

test("a child link with no usable id is reported unknown, not dropped", async () => {
  const state = { wp: workPackage({ _links: { children: [{ href: "/api/v3/work_packages/x", title: "Odd" }] } }) };
  const { request } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.deepEqual(result.children, { moved: [], notMoved: [], unknown: [{ id: null, subject: "Odd" }] });
});

test("already in the target with an unreadable type is a no-op, not a refusal", async () => {
  const state = {
    wp: workPackage({ _links: { project: { href: "/api/v3/projects/5", title: "Desktop" }, type: { href: null } } }),
  };
  const { request } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.equal(result.projectNote, "Already in project Desktop; not moved.");
});

test("MOVE_UNVERIFIED says when the answer carries no project", async () => {
  const state = { wp: workPackage() };
  const { request } = fakeApi(patchedRoutes(state, (next) => (next._links.project = { href: null })));
  await assert.rejects(
    () => update({ id: 1677, projectId: "desktop" }, request),
    (error) => error.code === "MOVE_UNVERIFIED" && /project could not be read from the answer/.test(error.message)
  );
});

test("TYPE_UNKNOWN has its own hint", async () => {
  const { toolErrorObject } = await import("../lib/errors.js");
  assert.match(toolErrorObject({ code: "TYPE_UNKNOWN", message: "x" }).hint, /type was not returned/);
  assert.match(toolErrorObject({ code: "MOVE_UNVERIFIED", message: "x" }).hint, /get_work_package/);
});

test("already in the target: the project's types are not even read", async () => {
  const state = { wp: workPackage({ _links: { project: { href: "/api/v3/projects/5", title: "Desktop" } } }) };
  const { request, calls } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop", subject: "Renamed" }, request);
  assert.equal(calls.some((c) => c.path.endsWith("/types")), false);
  assert.equal(result.projectNote, "Already in project Desktop; not moved. The other changes in this call were applied.");
});

test("a target with no types enabled says so", async () => {
  const state = { wp: workPackage(), types: collection([]) };
  const { request } = fakeApi(moveRoutes(state));
  await assert.rejects(() => update({ id: 1677, projectId: "desktop" }, request), /No types are enabled there\./);
});

test("validate_update words the refusal as a check, not as a move", async () => {
  const state = { wp: workPackage(), types: TASK_AND_BUG };
  const { request } = fakeApi(moveRoutes(state));
  const result = await validate({ id: 1677, projectId: "desktop" }, request);
  assert.match(result.errors[0].message, /^Type "Ops" is not enabled in project Desktop/);
});

test("validate_update with an unreadable type is invalid with TYPE_UNKNOWN wording", async () => {
  const state = { wp: workPackage({ _links: { type: { href: null } } }) };
  const { request } = fakeApi(moveRoutes(state));
  const result = await validate({ id: 1677, projectId: "desktop" }, request);
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /could not be read/);
});

test("an unreadable type in the PATCH answer is MOVE_UNVERIFIED, not TYPE_CHANGED", async () => {
  const state = { wp: workPackage() };
  const { request } = fakeApi(patchedRoutes(state, (next) => (next._links.type = { href: null })));
  await assert.rejects(
    () => update({ id: 1677, projectId: "desktop" }, request),
    (error) => error.code === "MOVE_UNVERIFIED" && /type could not be read from the answer/.test(error.message)
  );
});

test("the children note names each child with its subject", async () => {
  const state = { wp: workPackage(), childProject: "/api/v3/projects/3" };
  const { request } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.match(result.childrenNote, /1678 \(Child\)/);
});

test("the children are read back from the PATCH answer when it lists them", async () => {
  const state = { wp: workPackage() };
  const { request } = fakeApi(patchedRoutes(state, (next) => (next._links.children = [])));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.equal(result.children, undefined, "the answer says it has no children now");
});

test("a padded projectId is trimmed before it is checked", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(moveRoutes(state));
  await update({ id: 1677, projectId: " desktop " }, request);
  assert.ok(calls.some((c) => c.method === "PATCH"));
});

test("a child with no usable id is named by its subject, never as null", async () => {
  const kids = [{ href: "/api/v3/work_packages/x", title: "Odd" }];
  const state = { wp: workPackage({ _links: { children: kids } }) };
  const { request } = fakeApi(moveRoutes(state));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.match(result.childrenNote, /could not be read: unknown id \(Odd\)/);
  assert.doesNotMatch(result.childrenNote, /null/);
});

test("validate_update carries the refusal code as data", async () => {
  const state = { wp: workPackage(), types: TASK_AND_BUG };
  const { request } = fakeApi(moveRoutes(state));
  const result = await validate({ id: 1677, projectId: "desktop" }, request);
  assert.equal(result.errors[0].code, "TYPE_NOT_ENABLED");
});

test("moved.to is the resolved target even when the answer embeds no project", async () => {
  const state = { wp: workPackage() };
  const { request } = fakeApi(patchedRoutes(state, (next) => (next._links.project = { href: "/api/v3/projects/5" })));
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.deepEqual(result.moved.to, { id: 5, identifier: "desktop", name: "Desktop" });
});

test("the children note lists at most 20 children per group and shortens long subjects", async () => {
  const kids = Array.from({ length: 60 }, (_, i) => ({ href: "/api/v3/work_packages/" + (3000 + i), title: "S".repeat(200) }));
  const state = { wp: workPackage({ _links: { children: kids } }) };
  const routes = [
    { method: "GET", path: /^\/api\/v3\/work_packages\/3\d{3}$/, reply: () => workPackage({ subject: "S".repeat(200), _links: { project: { href: "/api/v3/projects/3" } } }) },
    ...moveRoutes(state),
  ];
  const { request } = fakeApi(routes);
  const result = await update({ id: 1677, projectId: "desktop" }, request);
  assert.match(result.childrenNote, /and 30 more/);
  assert.match(result.childrenNote, /S{80}\.\.\.\)/, "subjects are cut at 80 characters");
  assert.ok(result.childrenNote.length < 6000, "note is bounded: " + result.childrenNote.length);
});
