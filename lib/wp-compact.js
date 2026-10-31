/**
 * Compact work-package shapes. Links are {id, name} with numeric ids; every
 * work-package result carries lockVersion, updatedAt, project and url.
 */
import { idFromHref, linkList, linkRef, webUrl } from "./tool-args.js";

function links(wp) {
  return (wp && wp._links) || {};
}

/** A project identifier passed by the caller (not a numeric id), or undefined. */
function identifierFromHint(hint) {
  if (!hint || /^\d+$/.test(String(hint))) return undefined;
  return String(hint);
}

export function wpProject(wp, identifierHint) {
  const link = links(wp).project;
  const embedded = wp && wp._embedded && wp._embedded.project;
  if (!link || !link.href) {
    return embedded ? { id: embedded.id, identifier: embedded.identifier, name: embedded.name } : null;
  }
  const project = { id: idFromHref(link.href), name: link.title != null ? link.title : null };
  const identifier = embedded?.identifier || identifierFromHint(identifierHint);
  if (identifier) project.identifier = identifier;
  if (project.name == null && embedded && embedded.name) project.name = embedded.name;
  return project;
}

export function wpParentId(wp) {
  const parent = links(wp).parent;
  return parent && parent.href ? idFromHref(parent.href) : null;
}

/** The small result returned by writes. */
export function summarizeWorkPackage(wp, baseUrl, identifierHint) {
  const l = links(wp);
  return {
    id: wp.id,
    subject: wp.subject,
    status: linkRef(l.status),
    type: linkRef(l.type),
    project: wpProject(wp, identifierHint),
    parentId: wpParentId(wp),
    lockVersion: wp.lockVersion,
    updatedAt: wp.updatedAt,
    url: webUrl(baseUrl, wp.id),
  };
}

/** The full compact view returned by get_work_package. */
export function describeWorkPackage(wp, baseUrl) {
  const l = links(wp);
  return {
    id: wp.id,
    subject: wp.subject,
    description: wp.description ? wp.description.raw : null,
    status: linkRef(l.status),
    type: linkRef(l.type),
    priority: linkRef(l.priority),
    assignee: linkRef(l.assignee),
    responsible: linkRef(l.responsible),
    author: linkRef(l.author),
    version: linkRef(l.version),
    parent: linkRef(l.parent),
    parentId: wpParentId(wp),
    ancestors: linkList(l.ancestors),
    childIds: linkList(l.children).map((child) => child.id),
    project: wpProject(wp),
    startDate: wp.startDate !== undefined ? wp.startDate : null,
    dueDate: wp.dueDate !== undefined ? wp.dueDate : null,
    derivedStartDate: wp.derivedStartDate !== undefined ? wp.derivedStartDate : null,
    derivedDueDate: wp.derivedDueDate !== undefined ? wp.derivedDueDate : null,
    scheduleManually: wp.scheduleManually !== undefined ? wp.scheduleManually : null,
    percentageDone: wp.percentageDone !== undefined ? wp.percentageDone : null,
    estimatedTime: wp.estimatedTime !== undefined ? wp.estimatedTime : null,
    remainingTime: wp.remainingTime !== undefined ? wp.remainingTime : null,
    createdAt: wp.createdAt,
    updatedAt: wp.updatedAt,
    lockVersion: wp.lockVersion,
    url: webUrl(baseUrl, wp.id),
  };
}
