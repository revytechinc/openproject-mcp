# SPDX-License-Identifier: BSD-2-Clause
# Copyright (c) 2026 REVYTECH, Inc.
#
# Portable Makefile for openproject-mcp (bmake and GNU make).
# See skill project-makefile-contract.
#
# Same target names on every OS. YES=1 / ASSUME_YES=1 skip prompts.

YES = 0
ASSUME_YES = 0
JSON = 0
REPO_PURPOSE = service

help:
	@printf '%s\n' \
		"purpose: $(REPO_PURPOSE)" \
		"Targets (same names on every OS):" \
		"  make purpose       print REPO_PURPOSE (for machines)" \
		"  make help          this message (default)" \
		"  make preflight     report missing tools (JSON=1 for --json)" \
		"  make install-deps  install npm packages (YES=1 to run npm install)" \
		"  make configure     nothing to configure in this repository" \
		"  make build         install npm packages if needed (npm install)" \
		"  make test          run node --test test/*.test.js" \
		"  make install       npm install -g . (requires YES=1)" \
		"" \
		"Switches: YES=1 or ASSUME_YES=1; JSON=1" \
		"Node.js >= 18 is required. Run make from the root of this checkout."

.PHONY: help purpose preflight deps install-deps configure build test install node-version

purpose:
	@printf '%s\n' "$(REPO_PURPOSE)"

node-version:
	@node -e "const major=Number(String(process.versions.node).split('.')[0]); if (!Number.isFinite(major) || major<18) { console.error('preflight: Node.js >= 18 is required, found '+process.versions.node); process.exit(1); }"

preflight: node-version
	@if [ "$(JSON)" = 1 ]; then \
		sh preflight.sh --json --purpose "$(REPO_PURPOSE)" node npm; \
	else \
		sh preflight.sh --purpose "$(REPO_PURPOSE)" node npm; \
	fi

deps install-deps: node-version
	@if sh preflight.sh --purpose "$(REPO_PURPOSE)" node npm; then \
		if [ -d node_modules ]; then \
			printf '%s\n' "install-deps: nothing missing"; \
		elif [ "$(YES)" = 1 ] || [ "$(ASSUME_YES)" = 1 ]; then \
			npm install; \
		else \
			printf '%s\n' "install-deps: node and npm are present; run make install-deps YES=1 to run npm install"; \
			exit 1; \
		fi; \
	else \
		os=`uname -s`; \
		printf '%s\n' "install-deps: os=$$os; install Node.js >= 18 and npm"; \
		case $$os in \
		FreeBSD|OpenBSD|NetBSD|DragonFly) printf '%s\n' "  pkg install node22 npm-node22" ;; \
		Darwin) printf '%s\n' "  brew install node" ;; \
		Linux) \
			if command -v apt-get >/dev/null 2>&1; then printf '%s\n' "  sudo apt-get install nodejs npm"; \
			elif command -v dnf >/dev/null 2>&1; then printf '%s\n' "  sudo dnf install nodejs npm"; \
			elif command -v apk >/dev/null 2>&1; then printf '%s\n' "  sudo apk add nodejs npm"; \
			elif command -v pacman >/dev/null 2>&1; then printf '%s\n' "  sudo pacman -S nodejs npm"; \
			else printf '%s\n' "  install Node.js >= 18 and npm with this OS's package manager"; fi ;; \
		*) printf '%s\n' "  install Node.js >= 18 and npm with this OS's package manager" ;; \
		esac; \
		if [ "$(YES)" = 1 ] || [ "$(ASSUME_YES)" = 1 ]; then \
			printf '%s\n' "install-deps: this Makefile will not escalate to install Node.js; install it, then re-run make install-deps YES=1."; \
			exit 1; \
		else \
			printf '%s\n' "install-deps: refusing to install automatically (set YES=1 or ASSUME_YES=1 if you are fully aware)."; \
			exit 1; \
		fi; \
	fi

configure:
	@printf '%s\n' "nothing to configure"

build: node-version
	@if [ ! -d node_modules ]; then npm install; else printf '%s\n' "build: nothing to compile; node_modules is present"; fi

test: node-version
	@node --test test/*.test.js

install: node-version
	@if [ "$(YES)" = 1 ] || [ "$(ASSUME_YES)" = 1 ]; then \
		npm install -g .; \
	else \
		printf '%s\n' "install: refusing to run npm install -g . without YES=1 or ASSUME_YES=1 (a dumb Makefile setting can wreck the system)."; \
		exit 1; \
	fi
