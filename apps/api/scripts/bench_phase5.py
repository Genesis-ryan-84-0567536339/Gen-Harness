#!/usr/bin/env python3
"""Giai đoạn 5.5 — benchmark hiệu năng THẬT trong môi trường sandbox này (KHÔNG bịa số).

Đo:
  1. Thời gian chèn 10 triệu dòng `raw.events` (batch, không qua service layer — chỉ để dựng dữ liệu benchmark
     nhanh, KHÔNG phải cách ứng dụng thật ghi dữ liệu).
  2. p50/p95/p99 của `GET /overview` (cụm queue) qua ĐÚNG đường API thật (FastAPI app trong tiến trình, không
     bỏ qua tầng HTTP/auth/scope), trước và sau khi thử tối ưu (nếu cần).
  3. Tốc độ xử lý thật của `Refinery.run()` trên một lô vài nghìn tin đã ingest qua đúng luồng
     (`gh.data.ingest.ingest_message`), dùng router quyết định tất định (không gọi LLM thật — sandbox này không
     có khoá API nhà cung cấp nào cấu hình sẵn; đo thông lượng tầng DB/business logic của refinery, không phải
     độ trễ mạng của một nhà cung cấp cụ thể — ghi rõ trong báo cáo).
  4. RAM rảnh (`free -h`) trong lúc chèn 10 triệu dòng.

Dùng CSDL RIÊNG `gh_bench_phase5` (không đụng CSDL dev/test khác). Script tự tạo, migrate, benchmark, rồi
XOÁ SẠCH (DROP DATABASE) ở cuối bằng try/finally — kể cả khi có lỗi giữa chừng hoặc bị Ctrl-C.

Chạy: cd apps/api && .venv/bin/python scripts/bench_phase5.py [--skip-10m] [--n 10000000]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from statistics import mean

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

PG = os.environ.get("GH_BENCH_PG", "postgresql://postgres:postgres@localhost:5432")
REDIS_URL = os.environ.get("GH_BENCH_REDIS", "redis://localhost:6379/13")
DB_NAME = "gh_bench_phase5"


def admin_sql(sql: str) -> None:
    import psycopg

    with psycopg.connect(f"{PG}/postgres", autocommit=True) as c:
        c.execute(sql)


def async_url(db: str) -> str:
    return f"{PG.replace('postgresql://', 'postgresql+asyncpg://')}/{db}"


def setup_db() -> dict[str, str]:
    print(f"[bench] tạo CSDL riêng {DB_NAME} (drop nếu đã có)…")
    admin_sql(f"DROP DATABASE IF EXISTS {DB_NAME} WITH (FORCE)")
    admin_sql(f"CREATE DATABASE {DB_NAME}")
    env = {**os.environ, "GH_DATABASE_URL": async_url(DB_NAME), "GH_REDIS_URL": REDIS_URL,
          "GH_COOKIE_SECURE": "false", "GH_MASTER_KEY": "", "GH_ENV": "test"}
    print("[bench] chạy migration (alembic upgrade heads)…")
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "heads"], cwd=API_DIR, env=env, check=True)
    return env


def teardown_db() -> None:
    print(f"[bench] dọn sạch: xoá CSDL {DB_NAME}…")
    admin_sql(f"DROP DATABASE IF EXISTS {DB_NAME} WITH (FORCE)")


async def bulk_insert_events(dsn: str, org_id: uuid.UUID, channel_id: uuid.UUID, n: int) -> float:
    import asyncpg

    conn = await asyncpg.connect(dsn)
    try:
        t0 = time.monotonic()
        await conn.execute(
            """INSERT INTO raw.events (org_id, received_at, occurred_at, channel_id, external_msg_id, kind,
                                       body_text, payload, content_hash)
               SELECT $1::uuid,
                      now() - (random() * interval '24 hours'),
                      now() - (random() * interval '24 hours'),
                      $2::uuid, 'bench-' || gs::text, 'text',
                      'Nội dung benchmark số ' || gs::text,
                      jsonb_build_object('n', gs, 'bench', true),
                      digest('bench-' || gs::text, 'sha256')
               FROM generate_series(1, $3) AS gs""",
            org_id, channel_id, n)
        return time.monotonic() - t0
    finally:
        await conn.close()


def free_ram_snapshot() -> str:
    return subprocess.run(["free", "-h"], capture_output=True, text=True, check=True).stdout


async def percentiles(latencies_ms: list[float]) -> dict[str, float]:
    s = sorted(latencies_ms)
    def pct(p: float) -> float:
        idx = min(len(s) - 1, int(len(s) * p))
        return s[idx]
    return {"p50": pct(0.50), "p95": pct(0.95), "p99": pct(0.99), "avg": mean(s), "n": len(s)}


async def bench_overview(env: dict[str, str], n_requests: int = 60) -> dict[str, float]:
    os.environ.update(env)
    from gh.config import get_settings
    get_settings.cache_clear()
    os.environ["GH_SETUP_TOKEN"] = "bench-setup-token"
    from gh.app import create_app

    app = create_app()
    async with app.router.lifespan_context(app):
        import httpx

        from tests.conftest import OWNER, Api, do_setup

        transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
        async with httpx.AsyncClient(transport=transport, base_url="http://bench") as client:
            api = Api(client)
            await do_setup(api)
            # khởi động (JIT các câu lệnh chuẩn bị, cache kế hoạch…) — không tính vào số đo
            for _ in range(3):
                r = await api.get("/overview")
                assert r.status_code == 200, r.text
            latencies = []
            for _ in range(n_requests):
                t0 = time.perf_counter()
                r = await api.get("/overview")
                latencies.append((time.perf_counter() - t0) * 1000)
                assert r.status_code == 200, r.text
    return await percentiles(latencies)


async def get_org_and_channel(env: dict[str, str]) -> tuple[uuid.UUID, uuid.UUID]:
    os.environ.update(env)
    from gh.config import get_settings
    get_settings.cache_clear()
    from sqlalchemy import text

    from gh.db import dispose_engine, sessionmaker
    async with sessionmaker()() as db:
        org = (await db.execute(text("SELECT id FROM core.organizations ORDER BY created_at LIMIT 1"))).scalar_one()
        ch = (await db.execute(text("SELECT id FROM core.channels WHERE org_id = :o AND type = 'zalo'"),
                               {"o": org})).scalar_one()
    await dispose_engine()
    return org, ch


async def bench_refinery(env: dict[str, str], n_messages: int = 3000) -> dict[str, float]:
    os.environ.update(env)
    from gh.config import get_settings
    get_settings.cache_clear()
    from redis.asyncio import Redis

    from gh.db import dispose_engine, sessionmaker
    from gh.refinery.runner import Refinery
    from tests.phase2 import install_presets, listen, msg, org_id, put
    from tests.test_refinery import by_text

    redis = Redis.from_url(REDIS_URL)
    await redis.flushdb()
    sm = sessionmaker()
    async with sm() as db:
        org = await org_id(db)
        await install_presets(db, org)
        await listen(db, org, "g1")
    payloads = [msg("Cần 3 container thép cuộn, giá bao nhiêu vậy em?" if i % 3 == 0 else "Chào cả nhà buổi sáng ạ")
               for i in range(n_messages)]
    t_ingest0 = time.monotonic()
    await put(sm, org, *payloads)
    ingest_s = time.monotonic() - t_ingest0

    t0 = time.monotonic()
    st = await Refinery(sm, redis, by_text()).run(org, "manual")  # type: ignore[arg-type]
    run_s = time.monotonic() - t0
    await redis.aclose()
    await dispose_engine()
    return {"messages": n_messages, "ingest_s": round(ingest_s, 2), "refine_s": round(run_s, 2),
           "processed": st.processed, "records_per_min": round(st.processed / run_s * 60, 1) if run_s > 0 else 0.0}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10_000_000)
    ap.add_argument("--skip-10m", action="store_true", help="bỏ qua chèn 10 triệu dòng (chỉ đo refinery)")
    ap.add_argument("--overview-requests", type=int, default=60)
    args = ap.parse_args()

    results: dict[str, object] = {}
    env = setup_db()
    try:
        org, channel = await get_org_and_channel(env)

        if not args.skip_10m:
            print(f"[bench] chèn {args.n:,} dòng raw.events…")
            insert_s = await bulk_insert_events(async_url(DB_NAME).replace("+asyncpg", ""), org, channel, args.n)
            results["insert_10m_seconds"] = round(insert_s, 2)
            results["insert_rows_per_sec"] = round(args.n / insert_s, 1)
            print(f"[bench] xong: {insert_s:.1f}s ({args.n / insert_s:,.0f} dòng/s)")
            results["free_ram_after_insert"] = free_ram_snapshot()

            print(f"[bench] đo GET /overview ({args.overview_requests} lượt, sau khi đã có {args.n:,} dòng)…")
            results["overview_ms"] = await bench_overview(env, args.overview_requests)
            print(json.dumps(results["overview_ms"], ensure_ascii=False))

        print("[bench] đo tốc độ Refinery.run() trên lô vài nghìn tin…")
        results["refinery"] = await bench_refinery(env)
        print(json.dumps(results["refinery"], ensure_ascii=False))

        print("\n[bench] KẾT QUẢ:")
        print(json.dumps(results, ensure_ascii=False, indent=2))
        Path("/tmp/bench_phase5_result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print("\n[bench] đã lưu /tmp/bench_phase5_result.json")
    finally:
        teardown_db()


if __name__ == "__main__":
    asyncio.run(main())
