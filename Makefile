# Manuscript Studio — local dev and test automation.
#
# Two supported flows:
#   `make dev`          — native Go server + Postgres in Docker (fast iteration)
#   `make dev-install`  — runs install.sh --dev (production-fidelity, Docker-packaged server)
#
# Tests:
#   `make test`         — runs test suite against `make dev`
#   `make test-install` — runs test suite against `make dev-install`
#
# Shared infrastructure:
#   `make postgres-up`  — bring up the dev Postgres container
#   `make test-repo`    — (re-)materialize the test manuscript git repo
#   `make clean`        — stop everything and delete dev state
#
# Dev config namespace: ~/.config/manuscript-studio-dev/
# Dev DB: localhost:5433
# Dev server: http://127.0.0.1:5001/

SHELL := /bin/bash

DEV_CONFIG_DIR := $(HOME)/.config/manuscript-studio-dev
DEV_CONFIG_FILE := $(DEV_CONFIG_DIR)/config.yaml
DEV_REPO_DIR := $(DEV_CONFIG_DIR)/repos/test-manuscripts
DEV_PRIVATE_DIR := $(DEV_CONFIG_DIR)/private
LIQUIBASE_IMAGE := manuscript-studio-liquibase
APP_IMAGE := manuscript-studio:latest

DB_HOST := localhost
DB_PORT := 5433
DB_NAME := manuscript_studio_dev
DB_USER := manuscript_dev
DB_PASSWORD := manuscript_dev

.PHONY: help
help:
	@echo "Targets:"
	@echo "  make dev            — native Go server (requires make postgres-up first)"
	@echo "  make dev-install    — full install.sh --dev (containerized server)"
	@echo "  make test           — run test suite against make dev"
	@echo "  make test-install   — run test suite against make dev-install"
	@echo "  make postgres-up    — start dev Postgres (5433)"
	@echo "  make postgres-down  — stop dev Postgres"
	@echo "  make test-repo      — (re-)materialize test manuscript git repo"
	@echo "  make db-reset       — drop and recreate dev database schema"
	@echo "  make seed           — seed admin + test user via admin endpoints"
	@echo "  make bootstrap      — trigger first migration for test manuscript"
	@echo "  make clean          — stop containers, delete dev state"

# ---- Infrastructure ----

.PHONY: postgres-up
postgres-up:
	docker compose -f docker-compose.dev.yaml up -d
	@echo "Waiting for postgres to be healthy..."
	@for i in $$(seq 1 30); do \
	    if docker compose -f docker-compose.dev.yaml exec -T postgres pg_isready -U $(DB_USER) -d $(DB_NAME) >/dev/null 2>&1; then \
	        echo "Postgres ready."; exit 0; \
	    fi; sleep 1; \
	done; \
	echo "Postgres did not become ready"; exit 1

.PHONY: postgres-down
postgres-down:
	docker compose -f docker-compose.dev.yaml down

.PHONY: test-repo
test-repo:
	MANUSCRIPT_STUDIO_DEV_CONFIG_DIR=$(DEV_CONFIG_DIR) ./testdata/init-test-repo.sh test-manuscripts

# ---- Native Go dev server ----

.PHONY: dev-config
dev-config:
	@mkdir -p $(DEV_CONFIG_DIR) $(DEV_CONFIG_DIR)/logs $(DEV_CONFIG_DIR)/repos $(DEV_PRIVATE_DIR)
	@if [ ! -f $(DEV_CONFIG_FILE) ]; then \
	    cp config.dev.yaml $(DEV_CONFIG_FILE); \
	    echo "Installed $(DEV_CONFIG_FILE)"; \
	fi

.PHONY: build
build:
	go build -o bin/manuscript-studio ./cmd/server
	go build -o bin/admin-upsert ./cmd/admin-upsert

.PHONY: liquibase-image
liquibase-image:
	@if ! docker image inspect $(LIQUIBASE_IMAGE) >/dev/null 2>&1; then \
	    docker build -f Dockerfile.liquibase -t $(LIQUIBASE_IMAGE) .; \
	fi

.PHONY: db-migrate
db-migrate: liquibase-image postgres-up
	docker run --rm --network host \
	    -e POSTGRES_HOST=$(DB_HOST) -e POSTGRES_PORT=$(DB_PORT) \
	    -e POSTGRES_DB=$(DB_NAME) -e POSTGRES_USER=$(DB_USER) -e POSTGRES_PASSWORD=$(DB_PASSWORD) \
	    $(LIQUIBASE_IMAGE) \
	    --changeLogFile=changelog/db.changelog-master.xml \
	    --url="jdbc:postgresql://$(DB_HOST):$(DB_PORT)/$(DB_NAME)" \
	    --username=$(DB_USER) --password=$(DB_PASSWORD) \
	    update

.PHONY: db-reset
db-reset: postgres-up
	PGPASSWORD=$(DB_PASSWORD) psql -h $(DB_HOST) -p $(DB_PORT) -U $(DB_USER) -d $(DB_NAME) \
	    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO $(DB_USER); GRANT ALL ON SCHEMA public TO public;"
	$(MAKE) db-migrate

# Seed admin + test user via admin endpoints. Uses config values.
.PHONY: seed
seed:
	@SYSTEM_TOKEN=$$(grep system_token $(DEV_CONFIG_FILE) | head -1 | sed 's/.*: *"\(.*\)".*/\1/') && \
	ADMIN_USER=$$(grep admin_username $(DEV_CONFIG_FILE) | head -1 | sed 's/.*: *"\(.*\)".*/\1/') && \
	ADMIN_PASS=$$(grep admin_password $(DEV_CONFIG_FILE) | head -1 | sed 's/.*: *"\(.*\)".*/\1/') && \
	MANUSCRIPT_NAME=$$(grep -A5 "manuscripts:" $(DEV_CONFIG_FILE) | grep "name:" | head -1 | sed 's/.*: *"\(.*\)".*/\1/') && \
	echo "Seeding admin user: $$ADMIN_USER" && \
	curl -sf -X POST http://127.0.0.1:5001/api/admin/users \
	    -H "Authorization: Bearer $$SYSTEM_TOKEN" -H "Content-Type: application/json" \
	    -d "{\"username\":\"$$ADMIN_USER\",\"password\":\"$$ADMIN_PASS\",\"role\":\"author\"}" >/dev/null && \
	curl -sf -X POST http://127.0.0.1:5001/api/admin/grants \
	    -H "Authorization: Bearer $$SYSTEM_TOKEN" -H "Content-Type: application/json" \
	    -d "{\"username\":\"$$ADMIN_USER\",\"manuscript_name\":\"$$MANUSCRIPT_NAME\"}" >/dev/null && \
	echo "Seeding test user: test/test" && \
	curl -sf -X POST http://127.0.0.1:5001/api/admin/users \
	    -H "Authorization: Bearer $$SYSTEM_TOKEN" -H "Content-Type: application/json" \
	    -d '{"username":"test","password":"test","role":"author"}' >/dev/null && \
	curl -sf -X POST http://127.0.0.1:5001/api/admin/grants \
	    -H "Authorization: Bearer $$SYSTEM_TOKEN" -H "Content-Type: application/json" \
	    -d "{\"username\":\"test\",\"manuscript_name\":\"$$MANUSCRIPT_NAME\"}" >/dev/null && \
	echo "Seeded."

.PHONY: bootstrap
bootstrap:
	@SYSTEM_TOKEN=$$(grep system_token $(DEV_CONFIG_FILE) | head -1 | sed 's/.*: *"\(.*\)".*/\1/') && \
	MANUSCRIPT_NAME=$$(grep -A5 "manuscripts:" $(DEV_CONFIG_FILE) | grep "name:" | head -1 | sed 's/.*: *"\(.*\)".*/\1/') && \
	echo "Triggering bootstrap for $$MANUSCRIPT_NAME" && \
	curl -sf -X POST http://127.0.0.1:5001/api/admin/sync \
	    -H "Authorization: Bearer $$SYSTEM_TOKEN" -H "Content-Type: application/json" \
	    -d "{\"manuscript_name\":\"$$MANUSCRIPT_NAME\"}" && echo

# Full dev stack: Postgres up, test repo ready, schema migrated, server running.
# Intentionally does NOT seed/bootstrap — tests control their own state.
.PHONY: dev
dev: dev-config build test-repo postgres-up db-migrate
	@echo "Starting native Go server on http://127.0.0.1:5001/"
	@echo "(Ctrl-C to stop. Run 'make seed' and 'make bootstrap' in another terminal.)"
	MANUSCRIPT_STUDIO_CONFIG_FILE=$(DEV_CONFIG_FILE) MANUSCRIPT_STUDIO_REPOS_DIR=$(DEV_CONFIG_DIR)/repos ./bin/manuscript-studio

# ---- Production-fidelity: full install.sh flow ----

.PHONY: dev-install
dev-install: dev-config test-repo postgres-up db-migrate
	./install.sh --dev

# ---- Tests ----

.PHONY: node-deps
node-deps:
	@if [ ! -d node_modules ]; then npm install; fi
	@npx playwright install chromium --with-deps 2>/dev/null || npx playwright install chromium

.PHONY: test-go
test-go:
	go test ./...

# Run tests against a running native dev server. Assumes `make dev` is up in another terminal.
# Resets DB, seeds, bootstraps, then runs tests.
.PHONY: test
test: node-deps
	$(MAKE) db-reset
	$(MAKE) seed
	$(MAKE) bootstrap
	$(MAKE) test-go
	./test-all.sh

.PHONY: test-install
test-install: dev-install node-deps
	$(MAKE) seed
	$(MAKE) bootstrap
	$(MAKE) test-go
	./test-all.sh

# ---- Cleanup ----

.PHONY: clean
clean:
	-docker stop manuscript-studio-dev-server 2>/dev/null || true
	-docker rm manuscript-studio-dev-server 2>/dev/null || true
	docker compose -f docker-compose.dev.yaml down -v
	rm -rf $(DEV_CONFIG_DIR)
	rm -rf bin
