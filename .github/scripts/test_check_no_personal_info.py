#!/usr/bin/env python3
"""Test cho check_no_personal_info.py — chạy: python3 -m unittest discover -s .github/scripts -p 'test_*.py'."""

from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_no_personal_info as check  # noqa: E402

# Ghép từ nửa chuỗi để chính tệp test này không chứa nguyên mẫu cấm.
HOST = "hub." + "genos" + ".top"
KHO = "Kho " + "Ryan"
ORG = "Genesis-ryan-84-0567536339"


class NoPersonalInfoTest(unittest.TestCase):
    def run_check(self, files: dict[str, str | bytes]) -> tuple[int, str]:
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            for rel, body in files.items():
                p = base / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                if isinstance(body, bytes):
                    p.write_bytes(body)
                else:
                    p.write_text(body, encoding="utf-8")
            with contextlib.redirect_stdout(out):
                code = check.main(["check_no_personal_info.py", str(base)])
        return code, out.getvalue()

    def test_clean_files_pass(self) -> None:
        code, out = self.run_check({
            "apps/web/src/screens/HubLinkCard.tsx": 'const P = "https://<địa-chỉ-gen-hub-của-bạn>/mcp";\n',
            "apps/api/gh/hub_link/service.py": 'KHO_LABEL = "Kho dữ liệu"\n',
            "packages/contracts/src/gen.ts": "export const KHO_LABEL = 'Kho dữ liệu';\n",
            "install.sh": "REPO=example/repo\n",
            "db/sql/0001.sql": "-- sạch\n",
        })
        self.assertEqual(code, 0, out)
        self.assertIn("Sạch", out)

    def test_hub_host_in_web_src_fails_with_github_annotation(self) -> None:
        code, out = self.run_check({"apps/web/src/screens/HubLinkCard.tsx": f'<input placeholder="https://{HOST}/mcp" />\n'})
        self.assertEqual(code, 1)
        self.assertIn("apps/web/src/screens/HubLinkCard.tsx:1", out)
        self.assertIn("::error file=apps/web/src/screens/HubLinkCard.tsx,line=1::", out)

    def test_each_forbidden_pattern_is_caught_case_insensitively(self) -> None:
        samples = {
            "apps/api/gh/a.py": f'X = "{KHO.upper()}"\n',
            "apps/api/gh/b.json": '{"email": "COLA.MKT@gmail.com"}\n',
            "packages/contracts/src/c.ts": "// vd " + "Anh " + "Cơ" + " La (design)\n",
            "deploy/d.yaml": "owner: " + "ryan" + "_genesis" + "@x\n",
            "db/sql/e.sql": "-- " + "boss" + ".ryan" + "\n",
            "install.ps1": f"# {HOST}\n",
        }
        for rel, body in samples.items():
            code, out = self.run_check({rel: body})
            self.assertEqual(code, 1, f"{rel}: {out}")
            self.assertIn(f"{rel}:1", out)

    def test_allow_comment_and_release_org_are_allowed(self) -> None:
        code, out = self.run_check({
            "db/sql/0035.sql": f"WHERE note = '...{KHO}...'; -- allow-personal-info\n",
            "install.sh": f'REPO="{ORG}/Gen-Harness"\n',
            "apps/genh/main.go": f'const repo = "{ORG}/Gen-Harness"\n',
            "apps/api/gh/config.py": f'release_repo = "{ORG}/Gen-Harness"\n',
        })
        self.assertEqual(code, 0, out)

    def test_org_string_does_not_hide_a_real_leak_on_the_same_line(self) -> None:
        code, out = self.run_check({"install.sh": f'REPO="{ORG}/x" # {HOST}\n'})
        self.assertEqual(code, 1)
        self.assertIn("install.sh:1", out)

    def test_out_of_scope_paths_and_binary_files_are_ignored(self) -> None:
        code, out = self.run_check({
            "apps/web/test/unit/hub.test.tsx": f"const U = 'https://{HOST}/mcp';\n",      # test/mock: không giao cho Owner
            "apps/web/e2e/x.spec.ts": f"{KHO}\n",
            "docs/releases/v0.1.26.md": f"{HOST}\n",
            "apps/genh/internal/ops/x_test.go": f'var h = "{HOST}"\n',
            "apps/web/src/node_modules/pkg/index.js": f"{HOST}\n",
            "apps/web/src/logo.png": b"\x89PNG\r\n\x1a\n\xff\xfe" + HOST.encode() + b"\n",
        })
        self.assertEqual(code, 0, out)

    def test_go_sources_outside_tests_are_scanned(self) -> None:
        code, out = self.run_check({"apps/genh/internal/update/x.go": f'var h = "{HOST}"\n'})
        self.assertEqual(code, 1)
        self.assertIn("apps/genh/internal/update/x.go:1", out)

    def test_missing_root_returns_2(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = check.main(["check_no_personal_info.py", "/khong/ton/tai/gen-harness"])
        self.assertEqual(code, 2)

    def test_real_repo_is_clean(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = check.main(["check_no_personal_info.py"])
        self.assertEqual(code, 0, out.getvalue())


if __name__ == "__main__":
    unittest.main()
