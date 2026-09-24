#!/usr/bin/env bash
# E2E trên hệ thống thật: Postgres + Redis cục bộ, api + worker thật, bridge giả (QR, danh bạ, tin nhắn),
# model giả tương thích OpenAI. Dùng CSDL gh_live và Redis db 3 (bị xoá mỗi lần chạy).
#   cd apps/web && bash e2e-live/run.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); API=$(cd "$HERE/../../api" && pwd); WEB=$(cd "$HERE/.." && pwd)
OUT=${LIVE_OUT:-$WEB/test-results/live-shots}; mkdir -p "$OUT"
PG=${GH_LIVE_PG:-postgresql://postgres:postgres@localhost:5432}
export GH_DATABASE_URL=${PG/postgresql:/postgresql+asyncpg:}/gh_live GH_REDIS_URL=redis://localhost:6379/3
export GH_SETUP_TOKEN=live-setup-token GH_COOKIE_SECURE=false GH_CLI_HOME=$OUT/agy/.gemini/antigravity-cli
export GH_MASTER_KEY=$(python3 -c 'import os,base64;print(base64.b64encode(os.urandom(32)).decode())')
export GH_BRIDGE_KEY=$(python3 -c 'import os,base64;print(base64.b64encode(os.urandom(32)).decode())')
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
psql "$PG/postgres" -qc "DROP DATABASE IF EXISTS gh_live WITH (FORCE)" -c "CREATE DATABASE gh_live"
redis-cli -n 3 flushdb >/dev/null
(cd "$API" && .venv/bin/alembic upgrade heads >/dev/null)
python3 "$HERE/fake_llm.py" > "$OUT/llm.log" 2>&1 & PIDS+=($!)
(cd "$API" && exec .venv/bin/uvicorn gh.main:app --port 8000) > "$OUT/api.log" 2>&1 & PIDS+=($!)
(cd "$API" && exec .venv/bin/arq gh.worker.WorkerSettings) > "$OUT/worker.log" 2>&1 & PIDS+=($!)
(cd "$WEB" && exec npx vite --port 5175 --strictPort) > "$OUT/web.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -sf localhost:5175/api/v1/health >/dev/null && break; sleep 1; done
export ORG=$(psql "$PG/gh_live" -tAc "SELECT id FROM core.organizations")
SCAN_AFTER=5 "$API/.venv/bin/python" "$HERE/fake_bridge.py" > "$OUT/bridge.log" 2>&1 & PIDS+=($!)
sleep 2
cd "$WEB" && LIVE_OUT=$OUT SEND_SCRIPT=$HERE/send.py PY=$API/.venv/bin/python \
  LIVE_BASE_URL=http://localhost:5175 npx playwright test -c playwright.live.config.ts live-phase2
