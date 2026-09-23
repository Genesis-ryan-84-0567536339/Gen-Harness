# Lối tắt cho nhà phát triển. Người dùng cuối cài bằng trình cài `genh` (giai đoạn 6).
COMPOSE = docker compose -f deploy/compose.yaml --env-file .env
API = apps/api

.PHONY: secrets up down logs logs-token ps api-dev api-test api-lint web-test bridge-test test migrate

secrets:
	@mkdir -p secrets
	@test -f secrets/gh_master_key || python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())" > secrets/gh_master_key
	@chmod 600 secrets/gh_master_key
	@test -f .env || cp .env.example .env
	@echo "Đã có secrets/gh_master_key và .env — nhớ đổi mật khẩu trong .env"

up: secrets
	$(COMPOSE) up -d --build
	@echo "Mở https://localhost:8443/setup — mã thiết lập: make logs-token"

logs-token:
	$(COMPOSE) logs api | grep -i "Mã thiết lập" | tail -1

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

migrate:
	cd $(API) && .venv/bin/alembic upgrade head

api-dev:
	cd $(API) && GH_COOKIE_SECURE=false .venv/bin/uvicorn gh.main:app --reload --port 8000

api-test:
	cd $(API) && .venv/bin/pytest -q

api-lint:
	cd $(API) && .venv/bin/ruff check gh tests && .venv/bin/mypy gh

web-test:
	npm run -w apps/web test

bridge-test:
	npm run -w apps/bridge test

test: api-lint api-test bridge-test web-test
