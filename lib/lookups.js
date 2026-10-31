/**
 * Name-or-id resolution shared by every named tool: status, type (per
 * project), priority, project, role and user. One createLookups() instance
 * per tool call; each collection is fetched at most once per instance.
 */
import { collectionElements } from "./api.js";
import { filtersParam, idFromHref, parseId, projectSegment } from "./tool-args.js";

function isIdLike(value) {
  return typeof value === "number" || /^#?\d+$/.test(String(value).trim());
}

function pickNamed(kind, items, ref, context) {
  if (isIdLike(ref)) {
    const id = parseId(ref, kind);
    const found = items.find((item) => Number(item.id) === id);
    if (found) return found;
    throw new Error(
      "Unknown " + kind + " id " + id + (context || "") + ". Valid: " + describe(items)
    );
  }
  const wanted = String(ref).trim().toLowerCase();
  const found = items.find((item) => String(item.name).toLowerCase() === wanted);
  if (found) return found;
  throw new Error(
    "Unknown " + kind + ' "' + ref + '"' + (context || "") + ". Valid: " + items.map((item) => item.name).join(", ")
  );
}

function describe(items) {
  return items.map((item) => item.name + " (" + item.id + ")").join(", ");
}

export function compactProject(project) {
  const parentHref = project._links && project._links.parent && project._links.parent.href;
  return {
    id: project.id,
    identifier: project.identifier,
    name: project.name,
    parentId: parentHref ? idFromHref(parentHref) : null,
    active: project.active !== undefined ? project.active : null,
    public: project.public !== undefined ? project.public : null,
  };
}

function compactUser(user) {
  const out = { id: user.id, name: user.name };
  if (typeof user.login === "string") out.login = user.login;
  return out;
}

export function createLookups(request) {
  const cache = new Map();
  function once(key, load) {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key);
  }
  async function list(endpoint) {
    return collectionElements(await request(endpoint));
  }

  const lookups = {
    async statuses() {
      const items = await once("statuses", () => list("/api/v3/statuses"));
      return items.map((s) => ({ id: s.id, name: s.name, isClosed: Boolean(s.isClosed) }));
    },
    async resolveStatus(ref) {
      return pickNamed("status", await lookups.statuses(), ref);
    },

    async project(ref) {
      const key = projectSegment(ref);
      const project = await once("project:" + key, () => request("/api/v3/projects/" + projectSegment(ref)));
      return compactProject(project);
    },

    /** Types the project allows, in OpenProject's order. */
    async projectTypes(ref) {
      const key = projectSegment(ref);
      const items = await once("types:" + key, () => list("/api/v3/projects/" + projectSegment(ref) + "/types"));
      return items.map((t) => ({ id: t.id, name: t.name }));
    },
    async allTypes() {
      const items = await once("types:*", () => list("/api/v3/types"));
      return items.map((t) => ({ id: t.id, name: t.name }));
    },
    /** Resolve a type in a project (or globally when project is null). */
    async resolveType(projectRef, ref) {
      if (projectRef == null) return pickNamed("type", await lookups.allTypes(), ref);
      return pickNamed("type", await lookups.projectTypes(projectRef), ref, " in project " + projectRef);
    },

    async priorities() {
      const items = await once("priorities", () => list("/api/v3/priorities"));
      return items.map((p) => ({ id: p.id, name: p.name, isDefault: Boolean(p.isDefault) }));
    },
    async resolvePriority(ref) {
      return pickNamed("priority", await lookups.priorities(), ref);
    },

    async roles() {
      const items = await once("roles", () => list("/api/v3/roles"));
      return items.map((r) => ({ id: r.id, name: r.name }));
    },
    async resolveRole(ref) {
      return pickNamed("role", await lookups.roles(), ref);
    },

    /**
     * Users whose login (or name) is exactly `login`. /api/v3/users is
     * admin-only, so /principals (any_name_attribute ~) is asked first and
     * matched exactly here; /users is the fallback only when that finds
     * nothing, and its 403 for a non-admin means "not found".
     */
    async findUsersByLogin(login) {
      const wanted = String(login).trim();
      return once("login:" + wanted, async () => {
        const principals = await list(
          "/api/v3/principals?filters=" +
            encodeURIComponent(
              filtersParam([
                { type: { operator: "=", values: ["User"] } },
                { any_name_attribute: { operator: "~", values: [wanted] } },
              ])
            )
        );
        const lower = wanted.toLowerCase();
        const exact = principals.filter(
          (u) =>
            (typeof u.login === "string" && u.login.toLowerCase() === lower) ||
            (typeof u.name === "string" && u.name.toLowerCase() === lower)
        );
        if (exact.length) return exact.map(compactUser);
        let users = [];
        try {
          users = await list(
            "/api/v3/users?filters=" + encodeURIComponent(filtersParam([{ login: { operator: "=", values: [wanted] } }]))
          );
        } catch (error) {
          if (!error || error.status !== 403) throw error;
          users = [];
        }
        return users.map(compactUser);
      });
    },
    async findUsersByName(name) {
      const filters = filtersParam([
        { type: { operator: "=", values: ["User"] } },
        { name: { operator: "~", values: [String(name)] } },
      ]);
      const items = await once("name:" + name, () =>
        list("/api/v3/principals?filters=" + encodeURIComponent(filters))
      );
      return items.map((u) => ({ id: u.id, name: u.name }));
    },
    /** The numeric id of the calling user. */
    async meId() {
      const me = await once("me", () => request("/api/v3/users/me"));
      return me.id;
    },
    /** "me", a numeric id, or a login → "me" | number. */
    async resolveUser(ref) {
      if (String(ref).trim().toLowerCase() === "me") return "me";
      if (isIdLike(ref)) return parseId(ref, "user");
      const found = await lookups.findUsersByLogin(String(ref).trim());
      if (found.length === 1) return found[0].id;
      throw new Error('Unknown user "' + ref + '": pass a user id, "me", or an exact login (see find_user)');
    },
  };
  return lookups;
}

/**
 * The type for a CloudBSD status work package: the preferred name, else Ops,
 * Feature, Task, else the first. Falls back to all types if the project's
 * types cannot be read.
 */
export async function resolvePreferredType(lookups, projectRef, preferredName) {
  const wanted = String(preferredName || "Ops").toLowerCase();
  let types = [];
  try {
    types = await lookups.projectTypes(projectRef);
  } catch {
    types = [];
  }
  if (!types.length) types = await lookups.allTypes();
  for (const name of [wanted, "ops", "feature", "task"]) {
    const found = types.find((item) => String(item.name).toLowerCase() === name);
    if (found) return found;
  }
  if (!types.length) {
    throw new Error("No OpenProject types available to create a status work package");
  }
  return types[0];
}

/** A status by name for status_upsert (null when no name). */
export async function resolveStatusByName(lookups, statusName) {
  if (!statusName) return null;
  const statuses = await lookups.statuses();
  const found = statuses.find(
    (item) => String(item.name).toLowerCase() === String(statusName).toLowerCase()
  );
  if (!found) {
    throw new Error(
      "Unknown status: " + statusName + ". Available: " + statuses.map((item) => item.name).join(", ")
    );
  }
  return found;
}
