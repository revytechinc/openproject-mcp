#!/bin/sh
#-
# SPDX-License-Identifier: BSD-2-Clause
#
# Copyright (c) 2026 REVYTECH, Inc.
#
# Portable preflight for the project Makefile contract.
# Usage: sh preflight.sh [--json] [--purpose NAME] [command ...]
# Default commands: git
# Exit 0 when every named command is on PATH (a legitimately empty default
# list still emits the contract and exits 0). Exit 1 when something is
# missing. Exit 2 on usage errors. --purpose NAME is included in --json
# (top-level "purpose" only, omitted when --purpose is not given).
set -u

# One list, used by usage and errors. The case below must stay in sync.
PURPOSES='application | library | tool | service | docs | config | data | skills | infra | fork'

json=0
purpose=
cmds=
while [ $# -gt 0 ]; do
	case $1 in
	--json) json=1 ;;
	--purpose)
		if [ $# -lt 2 ]; then
			printf 'preflight.sh: --purpose needs a non-empty name; use %s\n' "$PURPOSES" >&2
			exit 2
		fi
		purpose=$2
		if [ -z "$purpose" ]; then
			printf 'preflight.sh: --purpose needs a non-empty name; use %s\n' "$PURPOSES" >&2
			exit 2
		fi
		shift
		;;
	-h|--help)
		printf '%s\n' "usage: preflight.sh [--json] [--purpose NAME] [command ...]" \
			"reports which commands are missing from PATH" \
			"make preflight JSON=1  # same, via the Makefile" \
			"--purpose NAME is the repository purpose, emitted as the top-level purpose field in --json" \
			"allowed NAME: $PURPOSES"
		exit 0
		;;
	--) shift; break ;;
	-*)
		printf 'preflight.sh: unknown option %s\n' "$1" >&2
		exit 2
		;;
	*)
		cmds="$cmds $1"
		;;
	esac
	shift
done
while [ $# -gt 0 ]; do
	cmds="$cmds $1"
	shift
done
# default list
if [ -z "$cmds" ]; then
	if [ -n "${PREFLIGHT_COMMANDS:-}" ]; then
		cmds=$PREFLIGHT_COMMANDS
	else
		cmds="git"
	fi
fi

# purpose is optional; when set it must be a known repository purpose
if [ -n "$purpose" ]; then
	case $purpose in
	application|library|tool|service|docs|config|data|skills|infra|fork) ;;
	*)
		printf 'preflight.sh: unknown --purpose %s; use %s\n' "$purpose" "$PURPOSES" >&2
		exit 2
		;;
	esac
fi

# allowlist names so they can be interpolated into JSON safely
ok_cmds=
i=0
for c in $cmds; do
	case $c in
	*[!A-Za-z0-9_.+-]*|"")
		printf 'preflight.sh: command name %s is not allowed\n' "$c" >&2
		exit 2
		;;
	esac
	ok_cmds="$ok_cmds $c"
	i=$((i + 1))
done

os=$(uname -s 2>/dev/null || printf 'unknown')
arch=$(uname -m 2>/dev/null || printf 'unknown')
# cwd without a trailing newline issue
cwd=$(pwd -P 2>/dev/null || pwd)

missing=0
# records: index|name|state|available|reason
rec=$ok_cmds
# emit later from a temp? keep in memory via two lists
status_human=
status_json=
idx=0
for c in $ok_cmds; do
	if command -v "$c" >/dev/null 2>&1; then
		path=$(command -v "$c")
		status_human="$status_human
ok    $c ($path)"
		status_json="$status_json
{\"index\": $idx, \"name\": \"$c\", \"state\": \"ok\", \"available\": true}"
	else
		missing=$((missing + 1))
		status_human="$status_human
miss  $c (not on PATH)"
		status_json="$status_json
{\"index\": $idx, \"name\": \"$c\", \"state\": \"missing\", \"available\": false, \"reason\": \"not on PATH\"}"
	fi
	idx=$((idx + 1))
done

# JSON: escape cwd and os only if needed — uname values are plain
json_escape() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

if [ "$json" = 1 ]; then
	printf '{\n'
	printf '  "schema_version": "1.0",\n'
	printf '  "tool": "preflight",\n'
	if [ -n "$purpose" ]; then
		printf '  "purpose": "%s",\n' "$(json_escape "$purpose")"
	fi
	printf '  "metadata": {\n'
	printf '    "os": "%s",\n' "$(json_escape "$os")"
	printf '    "arch": "%s",\n' "$(json_escape "$arch")"
	printf '    "cwd": "%s",\n' "$(json_escape "$cwd")"
	printf '    "checked": %s\n' "$idx"
	printf '  },\n'
	printf '  "status": ['
	first=1
	# reprint status objects
	idx=0
	for c in $ok_cmds; do
		[ "$first" = 1 ] || printf ','
		first=0
		printf '\n    '
		if command -v "$c" >/dev/null 2>&1; then
			printf '{"index": %s, "name": "%s", "state": "ok", "available": true}' "$idx" "$c"
		else
			printf '{"index": %s, "name": "%s", "state": "missing", "available": false, "reason": "not on PATH"}' "$idx" "$c"
		fi
		idx=$((idx + 1))
	done
	printf '\n  ],\n'
	printf '  "items": []\n'
	printf '}\n'
else
	if [ -n "$purpose" ]; then
		printf 'preflight: purpose=%s os=%s arch=%s\n' "$purpose" "$os" "$arch"
	else
		printf 'preflight: os=%s arch=%s\n' "$os" "$arch"
	fi
	printf '%s\n' "$status_human" | sed '/^$/d'
	if [ "$missing" -eq 0 ]; then
		printf 'preflight: all %s command(s) present\n' "$idx"
	else
		printf 'preflight: %s command(s) missing\n' "$missing"
	fi
fi

if [ "$missing" -gt 0 ]; then
	exit 1
fi
exit 0
