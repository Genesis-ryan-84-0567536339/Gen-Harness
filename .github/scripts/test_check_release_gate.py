#!/usr/bin/env python3
"""Test cho check_release_gate.py — chạy: python3 -m unittest discover -s .github/scripts -p 'test_*.py'.

Mỗi test chép 3 workflow THẬT của repo sang thư mục tạm, gỡ đúng một mắt xích của cổng phát hành, rồi khẳng định
script bắt được (và repo nguyên trạng thì sạch).
"""

from __future__ import annotations

import contextlib
import io
import shutil
import sys
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_release_gate as gate  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


class ReleaseGateTest(unittest.TestCase):
    def run_gate(self, mutate: Callable[[Path], None] | None = None) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in (gate.CI_PATH, gate.INSTALLER_PATH, gate.RELEASE_PATH, gate.E2E_PATH):
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / rel, root / rel)
            if mutate:
                mutate(root)
            err = io.StringIO()
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                code = gate.main(["--root", str(root)])
            return code, err.getvalue()

    @staticmethod
    def replace(rel: str, old: str, new: str) -> Callable[[Path], None]:
        def mutate(root: Path) -> None:
            p = root / rel
            s = p.read_text(encoding="utf-8")
            assert old in s, f"không thấy đoạn cần sửa trong {rel}: {old!r}"
            p.write_text(s.replace(old, new), encoding="utf-8")

        return mutate

    def test_repo_nguyen_trang_sach(self) -> None:
        code, err = self.run_gate()
        self.assertEqual(code, 0, err)

    def test_promote_khong_ghi_dau_promoted_at(self) -> None:
        code, err = self.run_gate(self.replace(gate.E2E_PATH, "genh:promoted_at=$(date", "genh:x=$(date"))
        self.assertEqual(code, 1)
        self.assertIn("không ghi dấu", err)

    def test_promote_ghi_dau_bang_lenh_rieng(self) -> None:
        # Nâng latest không kèm ghi chú có dấu ⇒ có lúc bản đã là latest mà chưa có dấu.
        one_cmd = '--prerelease=false --latest --notes-file "$notes"'
        code, err = self.run_gate(self.replace(gate.E2E_PATH, one_cmd, "--prerelease=false --latest"))
        self.assertEqual(code, 1)
        self.assertIn("CÙNG một lệnh", err)

    def test_thieu_e2e_selfupdate(self) -> None:
        code, err = self.run_gate(self.replace(gate.E2E_PATH, "  e2e-selfupdate:\n", "  e2e-selfupdate-cu:\n"))
        self.assertEqual(code, 1)
        self.assertIn("e2e-selfupdate", err)

    def test_build_images_gan_latest(self) -> None:
        line = "gen-harness-${{ matrix.service }}:${{ needs.meta.outputs.version }}\n"
        latest = "${{ env.REGISTRY }}/${{ needs.meta.outputs.owner_lower }}/gen-harness-${{ matrix.service }}:latest"
        extra = line + "            " + latest + "\n"
        code, err = self.run_gate(self.replace(gate.RELEASE_PATH, line, extra))
        self.assertEqual(code, 1)
        self.assertIn(":latest", err)

    def test_release_khong_phai_prerelease(self) -> None:
        code, err = self.run_gate(self.replace(gate.RELEASE_PATH, "prerelease: true", "prerelease: false"))
        self.assertEqual(code, 1)
        self.assertIn("prerelease: true", err)

    def test_release_khong_cho_installer(self) -> None:
        code, err = self.run_gate(self.replace(gate.RELEASE_PATH, "needs: [meta, ci, installer,", "needs: [meta, ci,"))
        self.assertEqual(code, 1)
        self.assertIn("'installer' trong needs", err)

    def test_thieu_job_installer(self) -> None:
        old = "uses: ./.github/workflows/installer-matrix.yml"
        code, err = self.run_gate(self.replace(gate.RELEASE_PATH, old, "uses: ./.github/workflows/khac.yml"))
        self.assertEqual(code, 1)
        self.assertIn("thiếu job `installer`", err)

    def test_installer_matrix_khong_goi_lai_duoc(self) -> None:
        code, err = self.run_gate(self.replace(gate.INSTALLER_PATH, "  workflow_call:\n", "  workflow_dispatch:\n"))
        self.assertEqual(code, 1)
        self.assertIn(gate.INSTALLER_PATH, err)

    def test_thieu_tag_guard(self) -> None:
        code, err = self.run_gate(self.replace(gate.RELEASE_PATH, "id: tag-guard", "id: tag-khac"))
        self.assertEqual(code, 1)
        self.assertIn("tag-guard", err)

    def test_promote_if_khong_doi_e2e_install(self) -> None:
        old = "needs.e2e-install.result == 'success' && needs.e2e-rollback"
        code, err = self.run_gate(self.replace(gate.E2E_PATH, old, "needs.e2e-rollback"))
        self.assertEqual(code, 1)
        self.assertIn("e2e-install.result", err)

    def test_thieu_job_e2e_rollback(self) -> None:
        code, err = self.run_gate(self.replace(gate.E2E_PATH, "  e2e-rollback:\n", "  e2e-rollback-cu:\n"))
        self.assertEqual(code, 1)
        self.assertIn("thiếu job `e2e-rollback`", err)
        self.assertIn("bản hỏng cố ý chưa chứng minh rollback mà vẫn promote", err)

    def test_promote_needs_thieu_e2e_rollback(self) -> None:
        old = "needs: [resolve, e2e-install, e2e-upgrade, e2e-rollback]"
        code, err = self.run_gate(self.replace(gate.E2E_PATH, old, "needs: [resolve, e2e-install, e2e-upgrade]"))
        self.assertEqual(code, 1)
        self.assertIn("thiếu 'e2e-rollback' trong needs", err)
        self.assertIn("bản hỏng cố ý chưa chứng minh rollback mà vẫn promote", err)

    def test_promote_if_khong_doi_e2e_rollback(self) -> None:
        old = " && needs.e2e-rollback.result == 'success'"
        code, err = self.run_gate(self.replace(gate.E2E_PATH, old, ""))
        self.assertEqual(code, 1)
        self.assertIn("e2e-rollback.result", err)
        self.assertIn("bản hỏng cố ý chưa chứng minh rollback mà vẫn promote", err)

    def test_selfupdate_khong_tu_lui(self) -> None:
        old = 'gh release edit "$PREV_TAG" --repo "$R" --latest'
        code, err = self.run_gate(self.replace(gate.E2E_PATH, old, 'echo "lùi tay"'))
        self.assertEqual(code, 1)
        self.assertIn("TỰ lùi", err)

    def test_selfupdate_thieu_quyen_ghi(self) -> None:
        old = "    # contents: write — bước rollback (if: failure()) tự lùi bản chính thức.\n    permissions:\n      contents: write\n"
        code, err = self.run_gate(self.replace(gate.E2E_PATH, old, ""))
        self.assertEqual(code, 1)
        self.assertIn("e2e-selfupdate` cần", err)


if __name__ == "__main__":
    unittest.main()
