/**
 * Work-package comments: add, list (compact), edit.
 */
import { collectionElements, wpHref } from "./api.js";
import { seg } from "./path.js";
import { checkArgs, idFromHref, linkRef, parseId, requireArg, withNotify } from "./tool-args.js";

const COMMENT_LIMIT = 2000;
const MAX_ACTIVITIES = 100;

export const COMMENT_TOOLS = [
  {
    name: "add_comment",
    description:
      "Post a comment on a work package (its activity stream). Use this to record progress or a decision on a ticket; " +
      "to change fields and comment in one go, use update_work_package with comment. " +
      "Note: #NNN in the text is auto-linked to work package NNN by OpenProject, so write a bare number if you do not mean a link. " +
      "Returns {activityId, workPackageId, createdAt}.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "number", description: "Work package ID" },
        workPackageId: { type: "number", description: "Alias for id" },
        comment: { type: "string", description: "Comment text (markdown)" },
        notify: { type: "boolean", description: "Send notifications (default true)", default: true },
      },
      required: ["comment"],
    },
  },
  {
    name: "list_activities",
    description:
      "Read a work package's comments and change history, compactly (newest first by default). " +
      "Use this instead of raw GET .../activities. Each comment is cut at 2000 characters. " +
      "Returns {workPackageId, total, count, hasMore, elements:[{id, createdAt, user:{id,name}, comment, changes[]}]}.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "number", description: "Work package ID" },
        workPackageId: { type: "number", description: "Alias for id" },
        limit: { type: "number", description: "Maximum entries (default 20, max 100)", default: 20 },
        order: { type: "string", enum: ["desc", "asc"], description: "desc = newest first (default)", default: "desc" },
        commentsOnly: { type: "boolean", description: "Only entries with a comment (default false)", default: false },
      },
    },
  },
  {
    name: "edit_comment",
    description:
      "Replace the text of an existing comment (activity) you wrote. Use list_activities to find the activityId. " +
      "Returns {activityId, workPackageId, updatedAt}.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        activityId: { type: "number", description: "Activity (comment) ID" },
        comment: { type: "string", description: "New comment text (markdown)" },
      },
      required: ["activityId", "comment"],
    },
  },
];

const TOOL = Object.fromEntries(COMMENT_TOOLS.map((tool) => [tool.name, tool]));

export function pickWpId(args, label) {
  const value = args.id !== undefined ? args.id : args.workPackageId;
  if (value === undefined) throw new Error(label + ": id is required");
  return parseId(value, "id");
}

function compactActivity(activity) {
  const raw = activity.comment && activity.comment.raw ? String(activity.comment.raw) : "";
  const out = {
    id: activity.id,
    createdAt: activity.createdAt,
    user: linkRef(activity._links && activity._links.user),
    comment: raw,
    changes: (activity.details || []).map((detail) => detail.raw).filter(Boolean),
  };
  if (raw.length > COMMENT_LIMIT) {
    out.comment = raw.slice(0, COMMENT_LIMIT) + "… [truncated: " + raw.length + " characters in full]";
    out.truncated = true;
  }
  return out;
}

export async function postComment(request, id, comment, notify) {
  const activity = await request(
    withNotify(wpHref(id) + "/activities", notify),
    "POST",
    { comment: { raw: String(comment) } }
  );
  return {
    activityId: activity && activity.id,
    workPackageId: id,
    createdAt: activity && activity.createdAt,
  };
}

/** Compact activity list; shared with get_work_package includeComments. */
export async function listActivities(request, id, { limit = 20, order = "desc", commentsOnly = false } = {}) {
  const size = Math.max(1, Math.min(MAX_ACTIVITIES, Math.floor(Number(limit) || 20)));
  if (order !== "desc" && order !== "asc") throw new Error('order must be "desc" or "asc"');
  // OpenProject returns the whole stream oldest-first; ordering and the limit are applied here.
  const payload = await request(wpHref(id) + "/activities?pageSize=" + size);
  let items = collectionElements(payload);
  if (commentsOnly) items = items.filter((item) => item.comment && item.comment.raw);
  const ordered = order === "desc" ? items.slice().reverse() : items;
  const page = ordered.slice(0, size);
  return {
    workPackageId: id,
    total: items.length,
    count: page.length,
    hasMore: items.length > page.length,
    elements: page.map(compactActivity),
  };
}

export async function handleCommentTool(name, rawArgs, request) {
  const tool = TOOL[name];
  if (!tool) return undefined;
  const args = checkArgs(tool, rawArgs);
  switch (name) {
    case "add_comment": {
      const id = pickWpId(args, name);
      requireArg(args, "comment", name);
      return postComment(request, id, args.comment, args.notify);
    }
    case "list_activities": {
      return listActivities(request, pickWpId(args, name), args);
    }
    case "edit_comment": {
      const activityId = parseId(args.activityId, "activityId");
      requireArg(args, "comment", name);
      const activity = await request("/api/v3/activities/" + seg(activityId, "id"), "PATCH", {
        comment: { raw: String(args.comment) },
      });
      return {
        activityId,
        workPackageId: idFromHref(activity && activity._links && activity._links.workPackage && activity._links.workPackage.href),
        updatedAt: (activity && (activity.updatedAt || activity.createdAt)) || null,
      };
    }
    default:
      return undefined;
  }
}
