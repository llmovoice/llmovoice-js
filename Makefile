SHELL := /bin/sh

PNPM ?= pnpm
NPM_TAG ?= next
REMOTE ?= origin
BRANCH ?= main
CONFIRM ?=

.DEFAULT_GOAL := help

.PHONY: help run install check build test test-e2e test-e2e-real test-telephony test-providers test-providers-real test-coverage security-audit benchmark supabase-reset supabase-lint supabase-test pack publish-dry-run publish push release dist

help:
	@echo "llmovoice.js release commands"
	@echo ""
	@echo "  make run                     Start the development server"
	@echo "  make install                 Install workspace dependencies"
	@echo "  make check                   Typecheck, test, build, and inspect npm tarballs"
	@echo "  make pack                    Write npm tarballs to artifacts/npm"
	@echo "  make publish-dry-run         Simulate publishing every public package"
	@echo "  make security-audit          Check production dependency advisories"
	@echo "  make benchmark               Measure local runtime/compiler/store overhead"
	@echo "  make test-e2e                Run the deterministic browser demo flow"
	@echo "  make test-e2e-real           Run credentialed Supabase + OpenAI browser E2E"
	@echo "  make test-telephony          Run OpenAI SIP sideband + Twilio Voice/SMS tests"
	@echo "  make test-providers          Run Mainland China provider protocol tests"
	@echo "  make test-providers-real     Run one explicitly enabled, billable provider smoke test"
	@echo "  make supabase-reset          Apply migrations to local Supabase"
	@echo "  make supabase-lint           Lint the local Supabase database"
	@echo "  make supabase-test           Verify RLS user isolation with pgTAP"
	@echo "  make push CONFIRM=push       Push BRANCH and tags to REMOTE"
	@echo "  make dist                    Push BRANCH to REMOTE and REMOTE/prod"
	@echo "  make publish CONFIRM=publish Publish packages using NPM_TAG (default: next)"
	@echo "  make release CONFIRM=release Push first, then publish packages"
	@echo ""
	@echo "Overrides: NPM_TAG=latest REMOTE=origin BRANCH=main"

run:
	$(PNPM) dev

install:
	$(PNPM) install

check:
	$(PNPM) release:check

build:
	$(PNPM) build

test:
	$(PNPM) test

test-e2e:
	$(PNPM) test:e2e

test-e2e-real:
	$(PNPM) test:e2e:real

test-telephony:
	$(PNPM) test:telephony

test-providers:
	$(PNPM) test:providers

test-providers-real:
	$(PNPM) test:providers:real

test-coverage:
	$(PNPM) test:coverage

security-audit:
	$(PNPM) security:audit

benchmark:
	$(PNPM) benchmark

supabase-reset:
	$(PNPM) supabase:reset

supabase-lint:
	$(PNPM) supabase:lint

supabase-test:
	$(PNPM) supabase:test

pack:
	$(PNPM) release:pack

publish-dry-run:
	NPM_TAG="$(NPM_TAG)" $(PNPM) release:publish:dry-run

publish:
	RELEASE_CONFIRM="$(CONFIRM)" NPM_TAG="$(NPM_TAG)" $(PNPM) release:publish

push:
	RELEASE_CONFIRM="$(CONFIRM)" GIT_REMOTE="$(REMOTE)" GIT_BRANCH="$(BRANCH)" $(PNPM) release:push

dist:
	git push $(REMOTE) $(BRANCH); git push $(REMOTE) $(BRANCH):prod

release:
	RELEASE_CONFIRM="$(CONFIRM)" NPM_TAG="$(NPM_TAG)" GIT_REMOTE="$(REMOTE)" GIT_BRANCH="$(BRANCH)" $(PNPM) release
