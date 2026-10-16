"""v0.1.63 H1 — cấu hình cô lập của `agy-box` trong deploy/compose.yaml (đọc YAML, không cần Docker).

Bản thật được kiểm thêm bằng hộp dựng thật (project riêng) — xem docs/api/agybox-protocol.md mục "Kiểm cô lập"."""

from pathlib import Path
from typing import Any

import pytest
import yaml

REPO = Path(__file__).resolve().parents[3]
COMPOSE = yaml.safe_load((REPO / "deploy" / "compose.yaml").read_text(encoding="utf-8"))
SERVICES: dict[str, Any] = COMPOSE["services"]
BOX: dict[str, Any] = SERVICES["agy-box"]
ENV_ALLOWED = {"GH_AGYBOX_KEY_FILE", "GH_CLI_HOME", "GH_CLI_BINARY", "AGY_CLI_DISABLE_AUTO_UPDATE",
               "GH_AGYBOX_MAX_JOBS"}


def _nets(svc: dict[str, Any]) -> set[str]:
    n = svc.get("networks", ["default"])
    return set(n if isinstance(n, list) else n.keys())


def test_box_has_only_the_agy_key_secret() -> None:
    assert BOX["secrets"] == ["gh_agy_key"]
    assert COMPOSE["secrets"]["gh_agy_key"] == {"file": "../secrets/gh_agy_key"}


def test_box_env_is_exactly_the_allowlist_no_db_redis_or_keys() -> None:
    env = BOX["environment"]
    assert set(env) == ENV_ALLOWED
    assert "env_file" not in BOX
    flat = " ".join(f"{k}={v}" for k, v in env.items()).lower()
    for bad in ("database", "redis", "master", "bridge", "browser", "offsite", "backup", "setup_token"):
        assert bad not in flat, bad


def test_box_networks_are_agy_bus_and_agy_out_only() -> None:
    assert _nets(BOX) == {"agy-bus", "agy-out"}
    nets = COMPOSE["networks"]
    assert nets["agy-bus"].get("internal") is True
    assert not nets["agy-out"].get("internal")
    assert "ports" not in BOX and "expose" not in BOX


def test_box_hardening() -> None:
    assert BOX["read_only"] is True
    assert BOX["cap_drop"] == ["ALL"]
    assert "cap_add" not in BOX
    assert "no-new-privileges:true" in BOX["security_opt"]
    assert not any("seccomp=unconfined" in o or "apparmor=unconfined" in o for o in BOX["security_opt"])
    assert BOX["init"] is True
    assert BOX["mem_limit"] == "1g" and BOX["cpus"] == 1.5 and BOX["pids_limit"] == 256
    assert BOX["tmpfs"] == ["/tmp:size=256m"]
    assert BOX.get("privileged") is not True and "user" not in BOX        # user gh của ảnh (không root)
    assert BOX["command"] == ["python", "-m", "gh.agybox.server"]
    assert BOX["build"]["dockerfile"] == "deploy/images/api.Dockerfile"
    assert BOX["healthcheck"]["test"][0] == "CMD" and "8090/healthz" in BOX["healthcheck"]["test"][-1]


def test_box_mounts_only_agy_state_nocopy_after_api() -> None:
    vols = BOX["volumes"]
    assert len(vols) == 1
    assert vols[0]["source"] == "agy_state" and vols[0]["target"] == "/var/lib/gh/agy"
    # Giống worker: api chép nội dung ảnh (chủ gh:gh) vào volume mới trước; hộp mount nocopy sau, không tranh chép.
    assert vols[0]["volume"] == {"nocopy": True}
    assert BOX["depends_on"] == {"api": {"condition": "service_started"}}
    for forbidden in ("claude_state", "gh_objects", "pg_data", "redis_data", "/var/run/docker.sock", "host"):
        assert forbidden not in str(vols)


def test_only_api_and_worker_reach_the_box() -> None:
    on_bus = {n for n, s in SERVICES.items() if "agy-bus" in _nets(s)}
    assert on_bus == {"api", "worker", "agy-box"}
    assert {n for n, s in SERVICES.items() if "agy-out" in _nets(s)} == {"agy-box"}
    holders = {n for n, s in SERVICES.items() if "gh_agy_key" in (s.get("secrets") or [])}
    assert holders == {"api", "worker", "agy-box"}
    for n in ("api", "worker"):
        assert SERVICES[n]["environment"]["GH_AGYBOX_URL"] == "http://agy-box:8090"
        assert SERVICES[n]["environment"]["GH_AGYBOX_KEY_FILE"] == "/run/secrets/gh_agy_key"
    for n in ("api", "worker"):
        assert "default" in _nets(SERVICES[n])


def test_box_not_on_default_or_browser_networks_and_peers_not_exposed() -> None:
    assert not _nets(BOX) & {"default", "browser", "browser-bus", "browser-out"}
    for n in ("db", "redis", "bridge", "browser-redis", "migrate"):
        assert not _nets(SERVICES[n]) & {"agy-bus", "agy-out"}, n


def test_agy_state_only_in_api_worker_box() -> None:
    users = {n for n, s in SERVICES.items() if "agy_state" in str(s.get("volumes", ""))}
    assert users == {"api", "worker", "agy-box"}


def test_make_secrets_generates_the_key() -> None:
    mk = (REPO / "Makefile").read_text(encoding="utf-8")
    assert "secrets/gh_agy_key ||" in mk and "secrets/gh_agy_key secrets/gh_offsite_key" in mk


@pytest.mark.parametrize("name", ["api", "worker"])
def test_api_worker_still_on_default_network_and_browser_bus(name: str) -> None:
    assert {"default", "browser-bus"} <= _nets(SERVICES[name])
