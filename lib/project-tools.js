/**
 * Project-scoped tools the upstream tool set lacked: versions, project
 * updates, and work package relations.
 *
 * Versions matter because the version boards are empty without them, and
 * relations matter because they are how work packages are ordered.
 */

import { hrefId } from "./api.js";
import {
  assertProjectApplied,
  numericId,
  projectBasePath,
  projectUpdateBody,
} from "./work-packages.js";

/**
 * relationType reads a relation's type from either shape: an object with a
 * name, a plain string, or a link.
 */
function relationType(relation) {
  if (!relation) return null;
  if (typeof relation.type === "string") return relation.type;
  if (relation.type && (relation.type.name || relation.type.title)) {
    return relation.type.name || relation.type.title;
  }
  const link = relation?._links?.type;
  if (link) return link.title || link.name || null;
  return null;
}

/**
 * relationEnd reads one end of a relation from either shape.
 */
function relationEnd(relation, key) {
  const direct = relation?.[key];
  if (direct?.href) return numericId(hrefId(direct.href));
  const link = relation?._links?.[key];
  if (link?.href) return numericId(hrefId(link.href));
  if (typeof direct === "number") return direct;
  return null;
}

export const PROJECT_TOOLS = [
  {
    name: "list_versions",
    description: "List the versions of a project.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID or identifier" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "create_version",
    description: "Create a version in a project",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID or identifier" },
        name: { type: "string", description: "Version name" },
        description: { type: "string", description: "Version description (markdown)" },
      },
      required: ["projectId", "name"],
    },
  },
  {
    name: "update_project",
    description: "Update a project's name, description or status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Project ID" },
        name: { type: "string", description: "New project name" },
        description: { type: "string", description: "New project description (markdown)" },
        status: { type: "string", description: "New project status" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_relations",
    description:
      "List the relations of a work package: precedes, relates, blocks.",
    inputSchema: {
      type: "object",
      properties: {
        workPackageId: { type: "number", description: "Work package ID" },
      },
      required: ["workPackageId"],
    },
  },
  {
    name: "create_relation",
    description:
      "Create a relation between two work packages. Types: relates, precedes, blocks.",
    inputSchema: {
      type: "object",
      properties: {
        fromId: { type: "number", description: "Source work package ID" },
        toId: { type: "number", description: "Target work package ID" },
        type: { type: "string", description: "Relation type", default: "relates" },
        description: { type: "string", description: "Relation description (markdown)" },
      },
      required: ["fromId", "toId"],
    },
  },
];

export async function handleProjectTool(name, args, apiRequest) {
  switch (name) {
    case "list_versions": {
      const base = await projectBasePath(apiRequest, args.projectId);
      const payload = await apiRequest(base + "/versions");
      return (payload._embedded?.elements || []).map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description?.raw ?? null,
        status: v.status?.name ?? null,
        startDate: v.startDate ?? null,
        endDate: v.endDate ?? null,
      }));
    }
    case "create_version": {
      const base = await projectBasePath(apiRequest, args.projectId);
      const body = { name: args.name };
      if (args.description) body.description = { format: "markdown", raw: args.description };
      const created = await apiRequest(base + "/versions", "POST", body);
      return { id: created.id, name: created.name };
    }
    case "update_project": {
      const updated = await apiRequest(
        "/api/v3/projects/" + args.id,
        "PATCH",
        projectUpdateBody(args)
      );
      const after = {
        id: updated.id,
        name: updated.name,
        identifier: updated.identifier,
        description: updated.description?.raw ?? null,
        status: updated.status?.name ?? null,
      };
      assertProjectApplied(after, args);
      return after;
    }
    case "get_relations": {
      const payload = await apiRequest(
        "/api/v3/work_packages/" + args.workPackageId + "/relations"
      );
      return (payload._embedded?.elements || []).map((r) => ({
        id: r.id,
        type: relationType(r),
        fromId: relationEnd(r, "from"),
        toId: relationEnd(r, "to"),
        description: r.description?.raw ?? null,
      }));
    }
    case "create_relation": {
      // The relation type is a plain string in the API, and the two ends are
      // links. Sending an object for the type is accepted and then ignored.
      const body = {
        from: { href: "/api/v3/work_packages/" + args.fromId },
        to: { href: "/api/v3/work_packages/" + args.toId },
        type: args.type || "relates",
      };
      if (args.description) body.description = { format: "markdown", raw: args.description };
      const created = await apiRequest("/api/v3/relations", "POST", body);
      const type = relationType(created);
      if (!type) {
        throw new Error(
          "the relation was created but its type could not be read back, " +
            "so the relation type was not applied"
        );
      }
      if (type !== body.type) {
        throw new Error(
          "the relation was created with type " + type + ", not " + body.type
        );
      }
      const fromId = relationEnd(created, "from");
      const toId = relationEnd(created, "to");
      if (fromId !== null && fromId !== args.fromId) {
        throw new Error(
          "the relation was created from " + fromId + ", not " + args.fromId
        );
      }
      if (toId !== null && toId !== args.toId) {
        throw new Error(
          "the relation was created to " + toId + ", not " + args.toId
        );
      }
      return { id: created.id, type: type, fromId: fromId, toId: toId };
    }
    default:
      return undefined;
  }
}
