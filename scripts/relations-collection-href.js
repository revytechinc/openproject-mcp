/**
 * Print the first-page collection URL the MCP GETs (involved filter +
 * DEFAULT_RELATION_PAGE_SIZE). Usage:
 *   node scripts/relations-collection-href.js <id>
 *
 * With --check-collection-body <id> <file>, exit 0 only if the JSON
 * is a collection whose elements (when present) all involve that work
 * package. Prints elements=<n> on success.
 */
import { readFileSync } from "node:fs";
import {
  relationsCollectionHref,
  relationInvolves,
  DEFAULT_RELATION_PAGE_SIZE,
} from "../lib/api.js";

function requireId(value) {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    process.stderr.write("relations-collection-href: work package id must be a positive integer\n");
    process.exit(2);
  }
  return value;
}

const argv = process.argv.slice(2);
if (argv[0] === "--check-collection-body") {
  const id = requireId(argv[1]);
  const file = argv[2];
  if (!file) {
    process.stderr.write("relations-collection-href: --check-collection-body needs a JSON file path\n");
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    process.stderr.write(
      "relations-collection-href: collection body is not JSON (check TRACK_API_BASE and the token in TRACK_CURL_CONFIG; a login page or proxy interstitial is a common cause)\n"
    );
    process.exit(1);
  }
  const elements =
    payload && payload._embedded && Array.isArray(payload._embedded.elements)
      ? payload._embedded.elements
      : null;
  if (!elements) {
    process.stderr.write("relations-collection-href: collection body is not a collection (_embedded.elements is missing or not an array)\n");
    process.exit(1);
  }
  const foreign = elements.filter((relation) => !relationInvolves(relation, id));
  if (foreign.length) {
    process.stderr.write(
      "relations-collection-href: collection returned " +
        foreign.length +
        " relation(s) that do not involve work package " +
        id +
        " (the involved filter was not honoured)\n"
    );
    process.exit(1);
  }
  process.stdout.write("elements=" + elements.length + "\n");
  process.exit(0);
}

const id = requireId(argv[0]);
process.stdout.write(
  relationsCollectionHref(id, { pageSize: String(DEFAULT_RELATION_PAGE_SIZE) }) + "\n"
);
