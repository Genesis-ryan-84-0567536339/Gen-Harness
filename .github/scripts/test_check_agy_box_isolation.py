"""Test check_agy_box_isolation.py (v0.1.63 H3): bản phát hành phải mang agy-box đúng cấu hình cô lập.

Mỗi vi phạm cách ly là một test riêng: sửa đúng MỘT chỗ của compose mẫu (khớp khối agy-box của H1) rồi đòi
script báo lỗi nhắc đúng chỗ đó. Không cần Docker."""

import copy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml  # type: ignore[import-untyped]  # PyYAML không kèm stub kiểu

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "check_agy_box_isolation.py"
sys.path.insert(0, str(HERE))
import check_agy_box_isolation as chk  # noqa: E402

API_IMG = "ghcr.io/o/gen-harness-api@sha256:" + "a" * 64

GOOD = {
    "services": {
        "db": {"image": "ghcr.io/o/gen-harness-db@sha256:" + "d" * 64, "secrets": ["gh_master_key"]},
        "redis": {"image": "redis:7-alpine"},
        "api": {
            "image": API_IMG,
            "secrets": ["gh_master_key", "gh_bridge_key", "gh_browser_key", "gh_offsite_key", "gh_agy_key"],
            "networks": ["default", "browser-bus", "agy-bus"],
            "volumes": ["agy_state:/var/lib/gh/agy", "claude_state:/var/lib/gh/claude"],
        },
        "worker": {
            "image": API_IMG,
            "secrets": ["gh_master_key", "gh_bridge_key", "gh_browser_key", "gh_agy_key"],
            "networks": ["default", "browser-bus", "agy-bus"],
        },
        "agy-box": {
            "image": API_IMG,
            "command": ["python", "-m", "gh.agybox.server"],
            "environment": {
                "GH_AGYBOX_KEY_FILE": "/run/secrets/gh_agy_key",
                "GH_CLI_HOME": "/var/lib/gh/agy/.gemini/antigravity-cli",
                "GH_CLI_BINARY": "agy",
                "AGY_CLI_DISABLE_AUTO_UPDATE": "1",
                "GH_AGYBOX_MAX_JOBS": "2",
            },
            "secrets": ["gh_agy_key"],
            "volumes": [{"type": "volume", "source": "agy_state", "target": "/var/lib/gh/agy", "volume": {"nocopy": True}}],
            "networks": ["agy-bus", "agy-out"],
            "read_only": True,
            "tmpfs": ["/tmp:size=256m"],
            "cap_drop": ["ALL"],
            "security_opt": ["no-new-privileges:true"],
            "init": True,
        },
    },
    "networks": {"default": {}, "browser-bus": {"internal": True}, "agy-bus": {"internal": True}, "agy-out": {}},
    "volumes": {"agy_state": None, "claude_state": None},
    "secrets": {k: {"file": f"../secrets/{k}"} for k in
                ["gh_master_key", "gh_bridge_key", "gh_browser_key", "gh_offsite_key", "gh_agy_key"]},
}


def box(d: dict) -> dict:
    return d["services"]["agy-box"]


def mutated(fn) -> dict:
    d = copy.deepcopy(GOOD)
    fn(d)
    return d


class IsolationRules(unittest.TestCase):
    def assertFlags(self, d: dict, needle: str, release: bool = True) -> None:
        errs = chk.check(d, release=release)
        self.assertTrue(any(needle in e for e in errs), f"muốn lỗi chứa {needle!r}, được {errs}")

    def test_good_compose_passes_both_modes(self) -> None:
        self.assertEqual(chk.check(GOOD, release=True), [])
        d = copy.deepcopy(GOOD)
        for s in ("api", "worker", "agy-box"):
            d["services"][s].pop("image")
            d["services"][s]["build"] = {"context": "..", "dockerfile": "deploy/images/api.Dockerfile"}
        self.assertEqual(chk.check(d, release=False), [])

    def test_missing_service(self) -> None:
        d = copy.deepcopy(GOOD)
        del d["services"]["agy-box"]
        self.assertFlags(d, "agy-box")

    def test_extra_secret(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(secrets=["gh_agy_key", "gh_master_key"])), "gh_master_key")

    def test_no_secret_at_all(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(secrets=[])), "gh_agy_key")

    def test_secret_long_syntax_extra(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(secrets=["gh_agy_key", {"source": "gh_bridge_key"}])), "gh_bridge_key")

    def test_default_network_explicit(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(networks=["agy-bus", "agy-out", "default"])), "default")

    def test_default_network_implicit(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).pop("networks")), "default")

    def test_network_mode_host(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(network_mode="host")), "network_mode")

    def test_agy_bus_not_internal(self) -> None:
        self.assertFlags(mutated(lambda d: d["networks"]["agy-bus"].update(internal=False)), "internal")

    def test_agy_bus_shared_with_other_service(self) -> None:
        self.assertFlags(mutated(lambda d: d["services"]["db"].update(networks=["default", "agy-bus"])), "agy-bus")

    def test_agy_out_shared_with_other_service(self) -> None:
        self.assertFlags(mutated(lambda d: d["services"]["api"]["networks"].append("agy-out")), "agy-out")

    def test_cap_drop_missing(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).pop("cap_drop")), "cap_drop")

    def test_cap_add(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(cap_add=["NET_ADMIN"])), "cap_add")

    def test_privileged(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(privileged=True)), "privileged")

    def test_no_new_privileges_missing(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(security_opt=[])), "no-new-privileges")

    def test_unconfined_security_opt(self) -> None:
        self.assertFlags(mutated(lambda d: box(d)["security_opt"].append("seccomp=unconfined")), "unconfined")

    def test_not_read_only(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(read_only=False)), "read_only")

    def test_root_user(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(user="root")), "user")

    def test_env_database_url(self) -> None:
        self.assertFlags(mutated(lambda d: box(d)["environment"].update(GH_DATABASE_URL="postgresql://x")), "GH_DATABASE_URL")

    def test_env_list_form(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(environment=["GH_REDIS_URL=redis://redis:6379"])), "GH_REDIS_URL")

    def test_env_file(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(env_file=[".env"])), "env_file")

    def test_extra_volume_named(self) -> None:
        self.assertFlags(mutated(lambda d: box(d)["volumes"].append("claude_state:/var/lib/gh/claude")), "claude_state")

    def test_bind_mount_short(self) -> None:
        self.assertFlags(mutated(lambda d: box(d)["volumes"].append("/var/run/docker.sock:/var/run/docker.sock")), "docker.sock")

    def test_bind_mount_long(self) -> None:
        self.assertFlags(mutated(lambda d: box(d)["volumes"].append({"type": "bind", "source": "../run", "target": "/x"})), "bind")

    def test_agy_state_missing(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(volumes=[])), "agy_state")

    def test_published_ports(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(ports=["8090:8090"])), "ports")

    def test_devices_and_pid_host(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(devices=["/dev/fuse"])), "devices")
        self.assertFlags(mutated(lambda d: box(d).update(pid="host")), "pid")

    def test_agy_key_leaks_to_other_service(self) -> None:
        self.assertFlags(mutated(lambda d: d["services"]["db"].update(secrets=["gh_master_key", "gh_agy_key"])), "gh_agy_key")

    def test_release_must_pin_digest(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(image="ghcr.io/o/gen-harness-api:latest")), "digest")

    def test_release_must_not_build(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(build={"context": ".."})), "build")

    def test_release_box_image_equals_api_image(self) -> None:
        self.assertFlags(mutated(lambda d: box(d).update(image="ghcr.io/o/gen-harness-api@sha256:" + "b" * 64)), "api")

    def test_source_mode_requires_api_dockerfile(self) -> None:
        d = copy.deepcopy(GOOD)
        for s in ("api", "worker"):
            d["services"][s].pop("image")
            d["services"][s]["build"] = {"context": "..", "dockerfile": "deploy/images/api.Dockerfile"}
        box(d).pop("image")
        box(d)["build"] = {"context": "..", "dockerfile": "deploy/images/browser.Dockerfile"}
        self.assertFlags(d, "api.Dockerfile", release=False)

    def test_one_line_build_string_form(self) -> None:
        # compose cho phép build: ./dir (chuỗi) — không phải api.Dockerfile ⇒ lỗi, không được vỡ script.
        d = copy.deepcopy(GOOD)
        box(d).pop("image")
        box(d)["build"] = "./x"
        self.assertFlags(d, "api.Dockerfile", release=False)


class Cli(unittest.TestCase):
    def run_cli(self, d: dict, *flags: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "compose.release.yaml"
            p.write_text(yaml.safe_dump(d, allow_unicode=True), encoding="utf-8")
            return subprocess.run([sys.executable, str(SCRIPT), str(p), *flags], capture_output=True, text=True, check=False)

    def test_exit_0_and_ok_message(self) -> None:
        r = self.run_cli(GOOD, "--release")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("OK", r.stdout)

    def test_exit_1_with_github_error_annotation(self) -> None:
        d = mutated(lambda d: box(d).update(secrets=["gh_agy_key", "gh_master_key"]))
        r = self.run_cli(d, "--release")
        self.assertEqual(r.returncode, 1)
        self.assertIn("::error::", r.stdout)
        self.assertIn("gh_master_key", r.stdout)

    def test_exit_2_when_file_missing(self) -> None:
        r = subprocess.run([sys.executable, str(SCRIPT), "/không/có/compose.yaml"], capture_output=True, text=True, check=False)
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
