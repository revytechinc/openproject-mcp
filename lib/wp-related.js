/**
 * Things hanging off a work package: relations, watchers, time entries.
 * (relation_upsert in cloudbsd-status.js creates relations idempotently.)
 */
import { collectionElements, wpHref } from "./api.js";
import { seg } from "./path.js";
import { createLookups } from "./lookups.js";
import { checkArgs, filtersParam, linkRef, parseId, requireArg } from "./tool-args.js";

const WP_ID = { type: "number", description: "Work package ID" };
const schema = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });

export const WP_RELATED_TOOLS = [
  {
    name: "list_relations",
    description:
      "List a work package's relations (blocks, precedes, relates, ...). Use relation_upsert to add one. " +
      "Returns [{id, type, from:{id,name}, to:{id,name}, description}].",
    inputSchema: schema({ id: WP_ID }, ["id"]),
  },
  {
    name: "delete_relation",
    description: "Delete one relation by its id (from list_relations). Requires confirm: true. Returns {deleted, relationId}.",
    inputSchema: schema(
      {
        relationId: { type: "number", description: "Relation id" },
        confirm: { type: "boolean", description: "Must be true" },
      },
      ["relationId", "confirm"]
    ),
  },
  {
    name: "list_watchers",
    description: "List who watches a work package. Returns [{id, name}].",
    inputSchema: schema({ id: WP_ID }, ["id"]),
  },
  {
    name: "add_watcher",
    description: "Add a watcher to a work package (find ids with find_user). Returns {workPackageId, watcher:{id,name}}.",
    inputSchema: schema(
      { id: WP_ID, userId: { type: "string", description: 'User id or "me" (a number is accepted too)' } },
      ["id", "userId"]
    ),
  },
  {
    name: "list_time_entries",
    description:
      "List time logged on a work package (log_time adds one). Returns {total, count, hasMore, elements:[{id, hours, spentOn, user, activity, comment}]}.",
    inputSchema: schema({ id: WP_ID }, ["id"]),
  },
];

const TOOL = Object.fromEntries(WP_RELATED_TOOLS.map((tool) => [tool.name, tool]));

export async function handleWpRelatedTool(name, rawArgs, request) {
  const tool = TOOL[name];
  if (!tool) return undefined;
  const args = checkArgs(tool, rawArgs);
  switch (name) {
    case "list_relations": {
      const id = parseId(requireArg(args, "id", name));
      const payload = await request(wpHref(id) + "/relations");
      return collectionElements(payload).map((relation) => ({
        id: relation.id,
        type: relation.type,
        from: linkRef(relation._links && relation._links.from),
        to: linkRef(relation._links && relation._links.to),
        description: relation.description != null ? relation.description : null,
      }));
    }
    case "delete_relation": {
      const relationId = parseId(requireArg(args, "relationId", name), "relationId");
      if (args.confirm !== true) throw new Error("delete_relation: pass confirm: true to delete relation " + relationId);
      await request("/api/v3/relations/" + seg(relationId, "id"), "DELETE");
      return { deleted: true, relationId };
    }
    case "list_watchers": {
      const id = parseId(requireArg(args, "id", name));
      const payload = await request(wpHref(id) + "/watchers");
      return collectionElements(payload).map((user) => ({ id: user.id, name: user.name }));
    }
    case "add_watcher": {
      const id = parseId(requireArg(args, "id", name));
      const lookups = createLookups(request);
      const user = await lookups.resolveUser(requireArg(args, "userId", name));
      const userId = user === "me" ? await lookups.meId() : user;
      const watcher = await request(wpHref(id) + "/watchers", "POST", {
        user: { href: "/api/v3/users/" + seg(userId, "id") },
      });
      return { workPackageId: id, watcher: { id: (watcher && watcher.id) || userId, name: (watcher && watcher.name) || null } };
    }
    case "list_time_entries": {
      const id = parseId(requireArg(args, "id", name));
      const params = new URLSearchParams();
      params.set("pageSize", "100");
      params.set("filters", filtersParam([{ work_package: { operator: "=", values: [String(id)] } }]));
      const payload = await request("/api/v3/time_entries?" + params.toString());
      const elements = collectionElements(payload).map((entry) => ({
        id: entry.id,
        hours: entry.hours,
        spentOn: entry.spentOn,
        user: linkRef(entry._links && entry._links.user),
        activity: linkRef(entry._links && entry._links.activity),
        comment: entry.comment ? entry.comment.raw || "" : "",
      }));
      const total = payload && payload.total !== undefined ? payload.total : elements.length;
      return { total, count: elements.length, hasMore: total > elements.length, elements };
    }
    default:
      return undefined;
  }
}
