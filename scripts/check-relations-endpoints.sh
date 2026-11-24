#!/bin/sh
# Regression probe for OpenProject 17.7.2 relation URLs.
#
# Usage (from the repository root, or any cwd; the script locates lib/api.js
# beside itself):
#   TRACK_CURL_CONFIG=/path/to/curl-config \
#   TRACK_API_BASE=https://your.openproject.example \
#     sh scripts/check-relations-endpoints.sh <work_package_id>
#
# TRACK_API_BASE defaults to https://track.cloudbsd.org. The Bearer in
# TRACK_CURL_CONFIG is sent only to that base. A work package id is
# required; there is no default id.
#
# Requires: curl, node (>=18, to build the same collection URL the MCP uses).
#
# TRACK_CURL_CONFIG is a curl --config file (see curl(1)), mode 0400 or 0600.
# It must contain the Authorization header and must not set url (the script
# supplies the URL). The token is never printed and never placed on argv.
# Example — replace <token>, never put the token on the command line:
#   silent = true
#   header = "Authorization: Bearer <token>"
#   header = "Accept: application/hal+json"
#
# This script only does GET and OPTIONS; it does not create or delete
# relations (so it cannot prove that POST is not a redirect — only that
# OPTIONS on the create path is not 3xx).
#
# Success: GET of the first-page collection URL (relationsCollectionHref
# with pageSize=100) is 2xx, not 3xx, and any embedded elements involve
# the given work package. The legacy GET /api/v3/work_packages/:id/relations
# may be 308; if it redirects, the Location must be the relations collection
# with an involved filter (pageSize may be absent). That 308 is recorded,
# not treated as a failure.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -z "${TRACK_CURL_CONFIG:-}" ]; then
  echo "check-relations-endpoints: set TRACK_CURL_CONFIG to a curl --config file (mode 0400 or 0600) that holds the Authorization header, e.g. TRACK_CURL_CONFIG=/path/to/curl-config" >&2
  exit 2
fi
if [ ! -f "$TRACK_CURL_CONFIG" ]; then
  echo "check-relations-endpoints: $TRACK_CURL_CONFIG is not a file; pass the path to a curl --config file that holds the Authorization header" >&2
  exit 2
fi
mode=$(stat -c %a "$TRACK_CURL_CONFIG" 2>/dev/null || stat -f %Lp "$TRACK_CURL_CONFIG")
case "$mode" in
  400|600) ;;
  *)
    echo "check-relations-endpoints: $TRACK_CURL_CONFIG is mode $mode; chmod 600 or 400 that file (other modes are refused so a group-readable token is not used)" >&2
    exit 2
    ;;
esac
# Do not print the file. Only silent, header, comments and blank lines are
# allowed, so the Bearer is only sent to the URL this script builds.
if ! awk '
  BEGIN { bad=0 }
  /^[[:space:]]*$/ { next }
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*silent([[:space:]]*=|[[:space:]]*$)/ { next }
  /^[[:space:]]*header[[:space:]]*=/ { next }
  { bad=1 }
  END { exit bad }
' "$TRACK_CURL_CONFIG"; then
  echo "check-relations-endpoints: $TRACK_CURL_CONFIG has a directive other than silent, header, a comment or a blank line; refusing it so the Bearer is only sent to the URL this script builds" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "check-relations-endpoints: node is required so the probe uses the same relationsCollectionHref() as the MCP (install Node.js >= 18)" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "check-relations-endpoints: curl is required (install curl, e.g. pkg install curl or apt-get install curl)" >&2
  exit 2
fi

BASE="${TRACK_API_BASE:-https://track.cloudbsd.org}"
case "$BASE" in
  *"#"*|https://*@*|http://*|https:///*)
    echo "check-relations-endpoints: TRACK_API_BASE must be an https:// URL with a host and no userinfo or fragment (refusing so the Bearer is not sent in the clear or to another destination)" >&2
    exit 2
    ;;
  https://*) ;;
  *)
    echo "check-relations-endpoints: TRACK_API_BASE must be an https:// URL (refusing so the Bearer is not sent in the clear or to another scheme)" >&2
    exit 2
    ;;
esac
while [ "$BASE" != "${BASE%/}" ]; do
  BASE=${BASE%/}
done
if [ "$BASE" = "https://" ]; then
  echo "check-relations-endpoints: TRACK_API_BASE has no host" >&2
  exit 2
fi

if [ $# -lt 1 ]; then
  echo "check-relations-endpoints: work package id is required (positive integer); the Bearer is sent to TRACK_API_BASE (default https://track.cloudbsd.org)" >&2
  exit 2
fi
WP_ID="$1"
case "$WP_ID" in
  ""|*[!0-9]*|0*) echo "check-relations-endpoints: work package id must be a positive integer" >&2; exit 2 ;;
esac

COLLECTION_PATH=$(node "$ROOT/scripts/relations-collection-href.js" "$WP_ID")
COLLECTION="${BASE}${COLLECTION_PATH}"
LEGACY="${BASE}/api/v3/work_packages/${WP_ID}/relations"

printf "probing %s work package %s\n" "$BASE" "$WP_ID"

# Always print the code; curl --max-redirs 0 exits non-zero on 3xx, which is
# expected for the legacy path and must not abort before the line is shown.
probe() {
  method=$1
  url=$2
  bodyfile=$3
  if [ -n "$bodyfile" ]; then
    curl -sS -K "$TRACK_CURL_CONFIG" -X "$method" -o "$bodyfile" \
      -w '%{http_code} %{redirect_url}' --max-redirs 0 "$url" || true
  else
    curl -sS -K "$TRACK_CURL_CONFIG" -X "$method" -o /dev/null \
      -w '%{http_code} %{redirect_url}' --max-redirs 0 "$url" || true
  fi
}

fail=0
check_out=
BODY=$(mktemp)
BODY_ERR=$(mktemp)
trap 'rm -f "$BODY" "$BODY_ERR"' EXIT
chmod 600 "$BODY" "$BODY_ERR"

legacy_out=$(probe GET "$LEGACY" "")
legacy_code=${legacy_out%% *}
legacy_redir=${legacy_out#* }
printf 'GET %s -> %s' "$LEGACY" "$legacy_code"
if [ -n "$legacy_redir" ] && [ "$legacy_redir" != "$legacy_code" ]; then
  printf ' redirect_url=%s' "$legacy_redir"
fi
printf '\n'
if [ -z "$legacy_code" ] || [ "$legacy_code" = "000" ]; then
  echo "FAIL: legacy GET produced no HTTP status (transport error or curl could not run)" >&2
  fail=1
fi
case "$legacy_code" in
  3??)
    case "$legacy_redir" in
      */api/v3/relations?*involved*) ;;
      *)
        echo "FAIL: legacy GET redirected to a URL that is not the relations collection with an involved filter" >&2
        fail=1
        ;;
    esac
    ;;
esac

coll_out=$(probe GET "$COLLECTION" "$BODY")
coll_code=${coll_out%% *}
coll_redir=${coll_out#* }
printf 'GET %s -> %s' "$COLLECTION" "$coll_code"
if [ -n "$coll_redir" ] && [ "$coll_redir" != "$coll_code" ]; then
  printf ' redirect_url=%s' "$coll_redir"
fi
printf '\n'

case "$coll_code" in
  2??)
    check_out=$(node "$ROOT/scripts/relations-collection-href.js" --check-collection-body "$WP_ID" "$BODY" 2>"$BODY_ERR") || {
      cat "$BODY_ERR" >&2
      rm -f "$BODY_ERR"
      echo "FAIL: collection GET was $coll_code but the body was not an involved-filter collection for work package $WP_ID" >&2
      fail=1
      check_out=""
    }
    rm -f "$BODY_ERR"
    ;;
  3??)
    echo "FAIL: collection GET returned a redirect ($coll_code); list_relations would be refused because this server does not follow redirects. Check TRACK_API_BASE, or report a new relations URL." >&2
    fail=1
    ;;
  401|403)
    echo "FAIL: collection GET expected 2xx, got $coll_code; check the token in TRACK_CURL_CONFIG" >&2
    fail=1
    ;;
  404)
    echo "FAIL: collection GET expected 2xx, got 404; check TRACK_API_BASE and the work package id" >&2
    fail=1
    ;;
  ""|000)
    echo "FAIL: collection GET produced no HTTP status (transport error or curl could not run)" >&2
    fail=1
    ;;
  *)
    echo "FAIL: collection GET expected 2xx, got $coll_code" >&2
    fail=1
    ;;
esac

opts_out=$(probe OPTIONS "$LEGACY" "")
opts_code=${opts_out%% *}
printf 'OPTIONS %s -> %s\n' "$LEGACY" "$opts_code"
case "$opts_code" in
  3??)
    echo "FAIL: OPTIONS on the work-package relations path returned a redirect ($opts_code)" >&2
    fail=1
    ;;
  ""|000)
    echo "FAIL: OPTIONS on the work-package relations path produced no HTTP status (transport error)" >&2
    fail=1
    ;;
esac

if [ "$fail" -ne 0 ]; then
  exit 1
fi
elements_n=${check_out#elements=}
case "$elements_n" in
  ""|*[!0-9]*) elements_n=0 ;;
esac
echo "OK: collection GET is ${coll_code} (not a redirect); ${elements_n} elements checked, all involve work package ${WP_ID}. OPTIONS on the create path is ${opts_code} (not a redirect). This script does not POST, so it does not prove the create path."
