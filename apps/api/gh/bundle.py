"""Gói hồ sơ Owner `.ghbundle` — chuyển toàn bộ CSDL + tài liệu + bí mật sang máy khác (HANDOFF-v0.1.1 §1b).

Hợp đồng chung với `genh export/import` (Go, agent khác) — KHÔNG được đổi mà không cập nhật cả hai phía:
- CLI: `python -m gh.bundle export --out <path|->` ghi bytes gói ra tệp hoặc **stdout** (`-`); log luôn ra
  **stderr** (kể cả khi `--out -`) để không lẫn vào bytes gói.
- CLI: `python -m gh.bundle import --in <path|->` đọc gói từ tệp hoặc **stdin** (`-`).
- Mật khẩu bắt buộc qua biến môi trường `GH_BUNDLE_PASSWORD` (≥ 12 ký tự) — không có tham số dòng lệnh nào
  nhận mật khẩu (tránh lộ qua `ps`/lịch sử shell).
- Mã thoát: `0` OK · `1` lỗi khác (thiếu/ngắn mật khẩu, lỗi hệ thống…) · `2` sai mật khẩu hoặc gói hỏng (GCM
  tag không khớp) · `3` phiên bản gói không tương thích, HOẶC alembic revision của gói MỚI HƠN CSDL đích hiện có
  (nhập một gói từ bản `gh` mới hơn vào máy chưa nâng cấp migrations tương ứng — từ chối thay vì phá schema).

Định dạng tệp (`GHBUNDLE1`):
    b"GHBUNDLE1\\n" + <header JSON, một dòng, KHÔNG newline cuối> + b"\\n" + <ciphertext>

`header` (JSON) là **associated data** của AES-256-GCM (đúng bytes đã ghi, không kèm hai dấu `\\n` bao quanh) —
sửa một byte bất kỳ trong header hay ciphertext đều làm giải mã thất bại (`InvalidTag`), không cần trường
checksum riêng. `header["v"]` là phiên bản ĐỊNH DẠNG PHONG BÌ (tham số KDF/cipher) — khác với
`manifest["package_version"]` bên trong tar (phiên bản CẤU TRÚC gói: tên tệp/thư mục trong tar).

Khoá mã hoá gói dẫn xuất từ mật khẩu bằng argon2id (salt ngẫu nhiên 16 byte lưu trong header) — KHÔNG dùng
`gh.crypto.encrypt` (phong bì đó dẫn khoá từ `GH_MASTER_KEY` của máy, không phải từ mật khẩu người dùng gõ vào
lúc export/import) — nhưng bí mật NẰM TRONG bản pg_dump vẫn nguyên phong bì `gh.crypto` (giai đoạn 1) như khi
nằm trong CSDL; gói chỉ bọc thêm một lớp AES-256-GCM khác ngoài cùng bằng khoá dẫn xuất mật khẩu.

Nội dung tar (sau khi giải mã lớp ngoài):
    manifest.json   — phiên bản gói, alembic revision hiện tại lúc export, thời điểm, số object, sha256 dump
    db.dump         — `pg_dump --format=custom` NGUYÊN VẸN (đã chứa bí mật mã hoá bằng khoá master CŨ)
    keys.json       — khoá master CŨ (và khoá bridge nếu máy nguồn có cấu hình) để nhập giải mã lại
    objects/…       — toàn bộ `ObjectStore` TRỪ tiền tố `backups/` (bản backup GFS không thuộc hồ sơ di động)

Nhập (`import`): giải mã → kiểm phiên bản/khả năng tương thích → NGẮT các kết nối khác đang mở tới CSDL đích
(`_terminate_other_connections`, phòng thủ thêm — `genh import` đã tự dừng api/worker trước theo hợp đồng
chung, đây chỉ đề phòng kết nối lạ khác) → `pg_restore --clean --if-exists` với `lock_timeout` đặt qua
`PGOPTIONS` (thất bại rõ ràng thay vì treo vô hạn nếu vẫn còn khoá) (xoá sạch CSDL đích trước, đúng ngữ nghĩa
"nhập = thay thế hoàn toàn", giống `gh.backup.restore_backup`) → ghi lại object
→ MÃ HOÁ LẠI mọi cột bí mật (đã bị `pg_restore` mang nguyên bản mã hoá bằng khoá master CŨ vào CSDL) bằng khoá
master HIỆN HÀNH của máy đích, dùng đúng `associated data` từng loại (không đổi AAD nào — đổi AAD tương đương
đổi bí mật, không giải mã lại được nữa). Khoá cũ == khoá hiện tại (nhập lại cùng máy, hoặc hai máy chia sẻ
`GH_MASTER_KEY`) → bỏ qua bước này (không cần giải mã/mã hoá lại vô ích).

Không đọc cả gói vào RAM nếu tránh được: `pg_dump`/`pg_restore` luôn ghi/đọc qua tệp tạm (không qua stdout của
subprocess); tar cũng dựng trên đĩa. Chỉ bước mã hoá/giải mã lớp ngoài cùng cần trọn `tar` trong bộ nhớ một lần
(AES-GCM của thư viện `cryptography` không hỗ trợ mã hoá theo luồng) — chấp nhận được vì đó là bước CUỐI, không
còn giữ thêm bản sao nào khác của cùng dữ liệu tại thời điểm đó.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import logging
import os
import shutil
import sys
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import orjson
import psycopg
from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from gh import crypto
from gh import db as dbmod
from gh.backup import database_name, libpq_url, recreate_database
from gh.chassis.objects import LocalObjectStore, ObjectStore, get_object_store
from gh.config import get_settings

log = logging.getLogger("gh.bundle")

MAGIC = b"GHBUNDLE1"
HEADER_VERSION = 1                      # phiên bản phong bì ngoài (tham số KDF/cipher) — xem docstring module
PACKAGE_VERSION = 1                     # phiên bản cấu trúc tar (manifest/db.dump/keys.json/objects)

ARGON2_TIME_COST = 3
ARGON2_MEMORY_COST_KIB = 64 * 1024       # 64 MiB, theo yêu cầu nhiệm vụ ("tham số mặc định mạnh")
ARGON2_PARALLELISM = 4
ARGON2_HASH_LEN = 32                     # khoá AES-256

MIN_PASSWORD_LEN = 12
OBJECTS_EXCLUDE_PREFIX = "backups/"      # bản backup GFS không thuộc hồ sơ di động (xem docstring module)

# Phòng thủ thêm trước `pg_restore --clean` (HANDOFF-v0.1.2 mục 2) — `genh import` đã tự DỪNG api/worker trước
# khi gọi lệnh này (hợp đồng chung), nhưng vẫn đặt `lock_timeout` để KHÔNG treo vô hạn nếu còn một kết nối lạ
# nào đó (vd. ai đó đang `psql` thủ công) giữ khoá trên bảng: thất bại rõ ràng (lỗi timeout) còn hơn treo mãi.
RESTORE_LOCK_TIMEOUT_MS = 30_000

# ─── các cột CSDL mã hoá bằng khoá master (`gh.crypto`) — rà theo mọi lời gọi `crypto.encrypt(...)` trong gh/ ──
# (table, cột khoá chính, cột bí mật, associated data — PHẢI khớp y hệt AAD dùng ở nơi mã hoá gốc, xem cạnh mỗi
# dòng để đối chiếu nếu AAD đổi ở nơi đó).
REENCRYPT_TARGETS: list[tuple[str, str, str, bytes]] = [
    ("agent.provider_keys", "id", "secret_enc", b"provider_key"),      # gh/providers/router.py::KEY_AAD
    ("agent.cli_profiles", "id", "token_enc", b"cli_token"),           # gh/providers/cli.py::CLI_AAD
    ("agent.mcp_servers", "id", "auth_enc", b"mcp_server_auth"),       # gh/mcp_api/routes.py::MCP_AAD
    ("core.channel_sessions", "id", "credential_enc", b"channel_session"),  # gh/data/ingest.py (literal)
    # Cột tồn tại từ 0001_baseline nhưng CHƯA có chỗ nào trong gh/ ghi/đọc nó (chưa nối dây tính năng TOTP) —
    # luôn NULL hiện tại nên nhánh này không có tác dụng gì, chỉ để không sót cột nếu tính năng được nối dây
    # sau mà quên cập nhật danh sách này (rà lại AAD thật khi đó, đây chỉ là giá trị tạm hợp lý).
    ("core.users", "id", "totp_secret_enc", b"totp_secret"),
]


class BundleError(Exception):
    """Lỗi gói hồ sơ — `code` là mã thoát CLI tương ứng (xem docstring module)."""

    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


def _usage_error(message: str) -> BundleError:
    return BundleError(message, 1)


def _bad_password_or_corrupt(message: str) -> BundleError:
    return BundleError(message, 2)


def _incompatible(message: str) -> BundleError:
    return BundleError(message, 3)


# ─── mật khẩu gói (KHÔNG liên quan `GH_MASTER_KEY` — xem docstring module) ─────────────────────────────────

def _bundle_password() -> str:
    pw = os.environ.get("GH_BUNDLE_PASSWORD", "")
    if len(pw) < MIN_PASSWORD_LEN:
        raise _usage_error(
            f"Thiếu hoặc sai biến môi trường GH_BUNDLE_PASSWORD (bắt buộc, tối thiểu {MIN_PASSWORD_LEN} ký tự)")
    return pw


def _derive_key(password: str, *, salt: bytes, time_cost: int, memory_cost: int, parallelism: int) -> bytes:
    return hash_secret_raw(password.encode(), salt, time_cost=time_cost, memory_cost=memory_cost,
                           parallelism=parallelism, hash_len=ARGON2_HASH_LEN, type=Type.ID)


# ─── DSN quản trị (pg_dump/pg_restore/đọc alembic_version) — superuser, xem HANDOFF §hợp đồng chung ────────

def _admin_database_url() -> str:
    return get_settings().effective_admin_database_url


def _current_alembic_revision(pg_url: str) -> str | None:
    """`None`: CSDL trống/chưa migrate lần nào (chưa có bảng `alembic_version`) — không có gì để so sánh."""
    try:
        with psycopg.connect(pg_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT version_num FROM alembic_version LIMIT 1")
            row = cur.fetchone()
            return row[0] if row else None
    except psycopg.Error as e:
        if "does not exist" in str(e).lower():
            return None
        raise


def _alembic_order() -> dict[str, int]:
    """Thứ hạng mọi revision theo script `apps/api/migrations` — 0 = mới nhất (head). Dùng để so sánh "mới
    hơn"/"cũ hơn" giữa revision của gói và revision hiện có ở CSDL đích, KHÔNG cần kết nối CSDL nào."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    api_dir = Path(__file__).resolve().parent.parent
    cfg = Config(str(api_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(api_dir / "migrations"))
    sd = ScriptDirectory.from_config(cfg)
    return {rev.revision: i for i, rev in enumerate(sd.walk_revisions())}


def _check_revision_compatible(bundle_rev: str | None, target_rev: str | None) -> None:
    if bundle_rev is None:
        return  # gói của một CSDL trống (chưa migrate) — luôn tương thích
    order = _alembic_order()
    if bundle_rev not in order:
        raise _incompatible(f"Alembic revision '{bundle_rev}' trong gói không rõ với migrations hiện có "
                            "(gói có thể đến từ một nhánh/phiên bản gh khác) — không tương thích")
    if target_rev is None or target_rev not in order:
        return  # CSDL đích trống hoặc dùng revision lạ (bỏ qua so sánh, restore sẽ ghi đè toàn bộ)
    if order[bundle_rev] < order[target_rev]:
        raise _incompatible(
            f"Alembic revision '{bundle_rev}' trong gói MỚI HƠN CSDL đích ('{target_rev}') — máy này chưa có "
            "migrations tương ứng, từ chối nhập để không phá schema. Nâng cấp gh trước khi nhập.")


# ─── liệt kê object (ObjectStore không có list() — xem gh/chassis/objects.py — đặc cách LocalObjectStore) ──

def _iter_local_objects(store: LocalObjectStore) -> list[str]:
    root = store.root.resolve()
    if not root.is_dir():
        return []
    keys = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            key = p.relative_to(root).as_posix()
            if not key.startswith(OBJECTS_EXCLUDE_PREFIX):
                keys.append(key)
    return keys


def _list_object_keys(store: ObjectStore) -> list[str]:
    if isinstance(store, LocalObjectStore):
        return _iter_local_objects(store)
    raise NotImplementedError(
        "gh.bundle chỉ liệt kê được object của LocalObjectStore (ObjectStore không có list() — xem "
        "gh/chassis/objects.py); cài đặt ObjectStore khác cần tự thêm cách liệt kê tương ứng ở đây.")


# ─── export ──────────────────────────────────────────────────────────────────────────────────────────────────

async def _export(out: str) -> None:
    password = _bundle_password()
    store = get_object_store()
    admin_url = _admin_database_url()

    with tempfile.TemporaryDirectory(prefix="gh-bundle-export-") as tmp_s:
        tmp = Path(tmp_s)
        dump_path = tmp / "db.dump"
        log.info("pg_dump -Fc CSDL %s …", database_name(admin_url))
        await _run(["pg_dump", "--format=custom", "--no-owner", "--file", str(dump_path), libpq_url(admin_url)])
        dump_sha256 = _sha256_file(dump_path)

        objects_dir = tmp / "objects"
        keys = _list_object_keys(store)
        for key in keys:
            data = await store.get(key)
            dest = objects_dir / key
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        log.info("Đã gom %d object (đã loại tiền tố %r)", len(keys), OBJECTS_EXCLUDE_PREFIX)

        keys_json: dict[str, Any] = {"master_key": base64.b64encode(crypto.master_key()).decode()}
        s = get_settings()
        if s.bridge_key or s.bridge_key_file:
            keys_json["bridge_key"] = base64.b64encode(crypto.bridge_key()).decode()
        (tmp / "keys.json").write_bytes(orjson.dumps(keys_json))

        manifest = {
            "package_version": PACKAGE_VERSION,
            "alembic_revision": _current_alembic_revision(libpq_url(admin_url)),
            "created_at": datetime.now(UTC).isoformat(),
            "object_count": len(keys),
            "db_dump_sha256": dump_sha256,
        }
        (tmp / "manifest.json").write_bytes(orjson.dumps(manifest))
        log.info("manifest: %s", manifest)

        tar_path = tmp / "bundle.tar"
        with tarfile.open(tar_path, "w") as tar:
            tar.add(tmp / "manifest.json", arcname="manifest.json")
            tar.add(dump_path, arcname="db.dump")
            tar.add(tmp / "keys.json", arcname="keys.json")
            if objects_dir.is_dir():
                for key in keys:
                    tar.add(objects_dir / key, arcname=f"objects/{key}")

        tar_bytes = tar_path.read_bytes()
        header, ciphertext = _encrypt_bundle(tar_bytes, password)
        header_line = orjson.dumps(header)
        blob = MAGIC + b"\n" + header_line + b"\n" + ciphertext

    if out == "-":
        sys.stdout.buffer.write(blob)
        sys.stdout.buffer.flush()
    else:
        await asyncio.to_thread(Path(out).write_bytes, blob)
    log.info("Đã xuất gói %s (%d byte, %d object, revision=%s)", out, len(blob), len(keys),
             manifest["alembic_revision"])


def _encrypt_bundle(tar_bytes: bytes, password: str) -> tuple[dict[str, Any], bytes]:
    salt, nonce = os.urandom(16), os.urandom(12)
    header: dict[str, Any] = {"v": HEADER_VERSION, "kdf": "argon2id", "time_cost": ARGON2_TIME_COST,
              "memory_cost": ARGON2_MEMORY_COST_KIB, "parallelism": ARGON2_PARALLELISM,
              "salt": base64.b64encode(salt).decode(), "nonce": base64.b64encode(nonce).decode()}
    key = _derive_key(password, salt=salt, time_cost=header["time_cost"], memory_cost=header["memory_cost"],
                      parallelism=header["parallelism"])
    aad = orjson.dumps(header)
    ciphertext = AESGCM(key).encrypt(nonce, tar_bytes, aad)
    return header, ciphertext


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ─── import ──────────────────────────────────────────────────────────────────────────────────────────────────

async def _import(inp: str) -> None:
    password = _bundle_password()

    with tempfile.TemporaryDirectory(prefix="gh-bundle-import-") as tmp_s:
        tmp = Path(tmp_s)
        raw_path = tmp / "bundle.raw"
        _copy_input(inp, raw_path)

        with raw_path.open("rb") as f:
            magic = f.readline().rstrip(b"\n")
            header_line = f.readline().rstrip(b"\n")
            ciphertext = f.read()

        if magic != MAGIC:
            raise _incompatible(f"Định dạng gói không nhận ra (magic={magic!r}, cần {MAGIC!r})")
        try:
            header = orjson.loads(header_line)
        except orjson.JSONDecodeError as e:
            raise _bad_password_or_corrupt(f"Header gói hỏng, không đọc được JSON: {e}") from e
        if header.get("v") != HEADER_VERSION:
            raise _incompatible(f"Phiên bản phong bì gói lạ (v={header.get('v')!r}, chỉ hỗ trợ {HEADER_VERSION})")

        tar_bytes = _decrypt_bundle(ciphertext, header, header_line, password)

        tar_path = tmp / "bundle.tar"
        tar_path.write_bytes(tar_bytes)
        del tar_bytes
        extract_dir = tmp / "extracted"
        extract_dir.mkdir()
        with tarfile.open(tar_path, "r") as tar:
            _safe_extract(tar, extract_dir)

        manifest = orjson.loads((extract_dir / "manifest.json").read_bytes())
        if manifest.get("package_version") != PACKAGE_VERSION:
            raise _incompatible(f"Phiên bản cấu trúc gói lạ (package_version={manifest.get('package_version')!r}, "
                                f"chỉ hỗ trợ {PACKAGE_VERSION})")

        dump_path = extract_dir / "db.dump"
        if _sha256_file(dump_path) != manifest.get("db_dump_sha256"):
            raise _bad_password_or_corrupt("sha256 của db.dump trong gói không khớp manifest.json — gói hỏng")

        admin_url = _admin_database_url()
        target_rev = _current_alembic_revision(libpq_url(admin_url))
        _check_revision_compatible(manifest.get("alembic_revision"), target_rev)

        # Tạo lại CSDL rỗng (ngắt mọi kết nối khác bằng DROP … WITH (FORCE)) thay vì `pg_restore --clean` — xem
        # gh.backup.recreate_database (bảng phân vùng làm --clean lỗi hàng loạt).
        await asyncio.to_thread(recreate_database, libpq_url(admin_url))
        log.info("pg_restore vào CSDL %s …", database_name(admin_url))
        await _run(["pg_restore", "--no-owner", "--dbname", libpq_url(admin_url), str(dump_path)])

        store = get_object_store()
        objects_dir = extract_dir / "objects"
        restored = 0
        if objects_dir.is_dir():
            for p in sorted(objects_dir.rglob("*")):
                if not p.is_file():
                    continue
                key = p.relative_to(objects_dir).as_posix()
                if key.startswith(OBJECTS_EXCLUDE_PREFIX):
                    continue  # phòng thủ — export không đóng gói backups/ nên không nên gặp, nhưng bỏ qua nếu có
                await store.put(key, p.read_bytes())
                restored += 1
        log.info("Đã khôi phục %d object", restored)

        keys_json = orjson.loads((extract_dir / "keys.json").read_bytes())
        old_master_key = base64.b64decode(keys_json["master_key"])
        await _reencrypt_secrets(old_master_key)

    log.info("Đã nhập gói OK (alembic_revision=%s)", manifest.get("alembic_revision"))


def _copy_input(inp: str, dest: Path) -> None:
    if inp == "-":
        with dest.open("wb") as out:
            shutil.copyfileobj(sys.stdin.buffer, out)
    else:
        shutil.copyfile(inp, dest)


def _decrypt_bundle(ciphertext: bytes, header: dict[str, Any], header_line: bytes, password: str) -> bytes:
    try:
        salt = base64.b64decode(header["salt"])
        nonce = base64.b64decode(header["nonce"])
        key = _derive_key(password, salt=salt, time_cost=int(header["time_cost"]),
                          memory_cost=int(header["memory_cost"]), parallelism=int(header["parallelism"]))
    except (KeyError, ValueError, TypeError) as e:
        raise _bad_password_or_corrupt(f"Header gói thiếu/sai tham số KDF: {e}") from e
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, header_line)
    except InvalidTag as e:
        raise _bad_password_or_corrupt("Sai GH_BUNDLE_PASSWORD hoặc gói đã bị sửa/hỏng (GCM tag không khớp)") from e


def _safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    dest_resolved = dest.resolve()
    for member in tar.getmembers():
        target = (dest_resolved / member.name).resolve()
        if dest_resolved != target and dest_resolved not in target.parents:
            raise _bad_password_or_corrupt(f"Gói chứa đường dẫn không an toàn: {member.name!r}")
    tar.extractall(dest, filter="data")


async def _reencrypt_secrets(old_master_key: bytes) -> None:
    if old_master_key == crypto.master_key():
        log.info("Khoá master cũ trùng khoá master hiện hành — bỏ qua bước mã hoá lại bí mật")
        return

    await dbmod.dispose_engine()  # pg_restore vừa thay toàn bộ schema/dữ liệu — không dùng engine/pool cũ
    sm = dbmod.sessionmaker()
    total = 0
    async with sm() as db:
        for table, id_col, secret_col, aad in REENCRYPT_TARGETS:
            rows = (await db.execute(
                text(f"SELECT {id_col}, {secret_col} FROM {table} WHERE {secret_col} IS NOT NULL"))).all()  # noqa: S608
            for row_id, blob in rows:
                plain = crypto.decrypt(bytes(blob), aad, key=old_master_key)
                new_blob = crypto.encrypt(plain, aad, key=crypto.master_key())
                await db.execute(text(f"UPDATE {table} SET {secret_col} = :v WHERE {id_col} = :i"),  # noqa: S608
                                 {"v": new_blob, "i": row_id})
                total += 1
        await db.commit()
    log.info("Đã mã hoá lại %d bí mật bằng khoá master hiện hành của máy này", total)


# ─── tiến trình con thật (giống gh/backup.py) ─────────────────────────────────────────────────────────────────

async def _run(cmd: list[str], *, env: dict[str, str] | None = None) -> None:
    full_env = {**os.environ, **env} if env else None
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                env=full_env)
    _out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} thất bại (mã {proc.returncode}): {err.decode(errors='replace')[-4000:]}")


# ─── ngắt kết nối khác tới CSDL đích trước `pg_restore --clean` (HANDOFF-v0.1.2 mục 2) ─────────────────────────

def _terminate_other_connections(pg_url: str) -> int:
    """Ngắt mọi kết nối KHÁC (không phải kết nối này) đang mở tới CSDL đích, qua `pg_terminate_backend` bằng
    URL quản trị — phòng trường hợp còn tiến trình cũ giữ khoá khiến `pg_restore --clean` treo hoặc thất bại vì
    "database is being accessed by other users". `genh import` đã tự dừng api/worker trước (hợp đồng chung),
    đây chỉ là lớp phòng thủ thêm nên lỗi kết nối tới CSDL `postgres` để chạy truy vấn KHÔNG làm dừng import
    (chỉ log cảnh báo, để `pg_restore` tự báo lỗi rõ ràng nếu thật sự còn kết nối giữ khoá)."""
    parts = urlsplit(pg_url)
    db_name = parts.path.lstrip("/")
    admin_conn_url = urlunsplit(parts._replace(path="/postgres"))
    try:
        with psycopg.connect(admin_conn_url, autocommit=True) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()", (db_name,))
            n = len(cur.fetchall())
    except psycopg.Error as e:
        log.warning("Không ngắt được kết nối khác tới CSDL đích %s trước khi phục hồi (bỏ qua, chỉ là phòng "
                    "thủ thêm): %s", db_name, e)
        return 0
    if n:
        log.info("Đã ngắt %d kết nối khác đang mở tới CSDL đích %s trước khi phục hồi", n, db_name)
    return n


# ─── CLI: `python -m gh.bundle export --out <path|-> | import --in <path|->` ───────────────────────────────

def _main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    parser = argparse.ArgumentParser(description="Gói hồ sơ Owner .ghbundle (export/import) — HANDOFF-v0.1.1 §1b")
    sub = parser.add_subparsers(dest="action", required=True)
    p_export = sub.add_parser("export", help="Xuất gói .ghbundle (mật khẩu qua GH_BUNDLE_PASSWORD)")
    p_export.add_argument("--out", required=True, help="Đường dẫn tệp ra, hoặc '-' cho stdout")
    p_import = sub.add_parser("import", help="Nhập gói .ghbundle (mật khẩu qua GH_BUNDLE_PASSWORD)")
    p_import.add_argument("--in", dest="inp", required=True, help="Đường dẫn tệp vào, hoặc '-' cho stdin")
    args = parser.parse_args(argv)

    try:
        if args.action == "export":
            asyncio.run(_export(args.out))
        else:
            asyncio.run(_import(args.inp))
        return 0
    except BundleError as e:
        log.error(str(e))
        return e.code
    except Exception as e:  # noqa: BLE001 — CLI: mọi lỗi khác chưa phân loại đi vào mã thoát 1
        log.error("Lỗi không mong đợi: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(_main())
