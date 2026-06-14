.DEFAULT_GOAL := help
COMPOSE := docker compose

# OSRM routing data (self-hosted engine). Override for other regions, e.g.:
#   make osrm-data OSRM_REGION=monaco OSRM_PBF_URL=https://download.geofabrik.de/europe/monaco-latest.osm.pbf
OSRM_REGION  ?= turkey
OSRM_PBF_URL ?= https://download.geofabrik.de/europe/turkey-latest.osm.pbf
OSRM_IMAGE   := ghcr.io/project-osrm/osrm-backend:v5.27.1

# Routing profile used by osrm-extract. "car" uses the bundled /opt/car.lua;
# "motorcycle" (or any other name) uses infra/osrm-profiles/<name>.lua, mounted
# into the container at /profiles. Example: make osrm-data OSRM_PROFILE=motorcycle
OSRM_PROFILE ?= car
ifeq ($(OSRM_PROFILE),car)
  OSRM_PROFILE_LUA := /opt/car.lua
else
  OSRM_PROFILE_LUA := /profiles/$(OSRM_PROFILE).lua
endif

.PHONY: help up down logs ps build restart migrate psql backend-tidy backend-test mobile-install mobile-start osrm-data osrm-up osrm-down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

up: ## Start the full backend stack (db, redis, nats, services)
	@[ -f .env ] || cp .env.example .env
	$(COMPOSE) up -d --build

down: ## Stop and remove containers
	$(COMPOSE) down

logs: ## Tail logs from all services
	$(COMPOSE) logs -f

ps: ## Show running containers
	$(COMPOSE) ps

build: ## Build all service images
	$(COMPOSE) build

restart: down up ## Restart the stack

migrate: ## Apply all database migrations in order (idempotent)
	@for f in $$(ls backend/migrations/*.sql | sort); do \
		echo "applying $$f"; \
		$(COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 -U $${POSTGRES_USER:-morider} -d $${POSTGRES_DB:-morider} < $$f || exit 1; \
	done

psql: ## Open a psql shell
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-morider} -d $${POSTGRES_DB:-morider}

backend-tidy: ## Run go mod tidy
	cd backend && go mod tidy

backend-test: ## Run Go unit tests
	cd backend && go test ./...

mobile-install: ## Install mobile dependencies
	cd mobile && npm install

mobile-start: ## Start the Expo dev server
	cd mobile && npx expo start

osrm-data: ## Download + preprocess OSRM routing data into infra/osrm (heavy, one-time). OSRM_PROFILE=car|motorcycle
	@mkdir -p infra/osrm
	@test -f infra/osrm/$(OSRM_REGION).osm.pbf || \
		(echo "downloading $(OSRM_PBF_URL)"; curl -L -o infra/osrm/$(OSRM_REGION).osm.pbf "$(OSRM_PBF_URL)")
	@echo "extracting with profile: $(OSRM_PROFILE) ($(OSRM_PROFILE_LUA))"
	docker run --rm -v "$(PWD)/infra/osrm:/data" -v "$(PWD)/infra/osrm-profiles:/profiles:ro" $(OSRM_IMAGE) osrm-extract -p $(OSRM_PROFILE_LUA) /data/$(OSRM_REGION).osm.pbf
	docker run --rm -v "$(PWD)/infra/osrm:/data" $(OSRM_IMAGE) osrm-partition /data/$(OSRM_REGION).osrm
	docker run --rm -v "$(PWD)/infra/osrm:/data" $(OSRM_IMAGE) osrm-customize /data/$(OSRM_REGION).osrm
	@echo "OSRM data ready ($(OSRM_PROFILE) profili). Start it with: make osrm-up OSRM_REGION=$(OSRM_REGION)"

osrm-up: ## Start the self-hosted OSRM service (run osrm-data first; set ROUTING_URL=http://osrm:5000)
	OSRM_REGION=$(OSRM_REGION) $(COMPOSE) --profile routing up -d osrm

osrm-down: ## Stop the self-hosted OSRM service
	$(COMPOSE) --profile routing stop osrm
