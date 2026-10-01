#!/usr/bin/env python3
"""Kiểm bất biến của CỔNG PHÁT HÀNH (v0.1.33, F-9/F-13).

Luồng phải giữ: CI xanh → bản thử (prerelease) → E2E (e2e-install.yml) cài
thật đúng tag → job `promote` nâng thành bản chính thức (latest). Script này
đọc 3 workflow và báo lỗi (tiếng Việt) nếu ai đó vô tình gỡ một mắt xích:

  - ci.yml gọi lại được từ release.yml: on.workflow_call.inputs.from_release,
    nhóm concurrency có nhắc from_release (lượt từ Release không bị huỷ ngang).
  - installer-matrix.yml gọi lại được (workflow_call.inputs.from_release,
    concurrency nhắc from_release); release.yml có job `installer` dùng nó.
  - release.yml: job `ci` dùng ./.github/workflows/ci.yml; job `release`
    needs `ci` + `installer`; bước `tag-guard` đứng TRƯỚC softprops (tag đã
    có mà trỏ commit khác / Release đã promote ⇒ dừng); bước softprops/action-gh-release tạo prerelease: true và
    make_latest: "false"; build-images KHÔNG gắn tag ảnh `:latest` (chạy
    trước E2E — `:latest` chỉ gắn ở promote).
  - e2e-install.yml: job `promote` có permissions.contents == write, needs
    e2e-install + e2e-upgrade và `if` đòi e2e-install.result == 'success'; promote ghi dấu `<!-- genh:promoted_at=… -->`
    (định dạng `date -u +%Y-%m-%dT%H:%M:%SZ`, khớp selfupdate.PromotedMarker)
    trong CÙNG lệnh `gh release edit … --latest --notes-file` — thời gian chín
    24 giờ của lịch đêm tính từ dấu này; job `e2e-selfupdate` (needs promote)
    kiểm đường genh cũ tự tải genh mới, có contents: write và bước
    `if: failure()` TỰ lùi (gh release edit $TAG --prerelease=true, $PREV_TAG
    --latest, kiểm releases/latest == PREV_TAG); workflow_dispatch có
    tag/promote/skip_e2e; bộ lọc paths của pull_request gồm apps/api/**,
    apps/web/Dockerfile, deploy/images/**, VERSION.

Chạy:  python3 .github/scripts/check_release_gate.py [--root <thư mục repo>]
Cần python3 + PyYAML. Lưu ý PyYAML (YAML 1.1) đọc khoá `on:` thành True.
Thoát 0 nếu mọi bất biến đúng, 1 nếu có lỗi (in từng lỗi), 2 nếu thiếu
tệp/PyYAML.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore[import-untyped]  # PyYAML không kèm stub kiểu
except ImportError:  # pragma: no cover - chỉ khi máy thiếu PyYAML
    print(
        "check_release_gate: thiếu PyYAML — cài bằng `python3 -m pip install pyyaml` rồi chạy lại.",
        file=sys.stderr,
    )
    sys.exit(2)

CI_PATH = ".github/workflows/ci.yml"
INSTALLER_PATH = ".github/workflows/installer-matrix.yml"
INSTALLER_USES = "./.github/workflows/installer-matrix.yml"
TAG_GUARD_ID = "tag-guard"
PROMOTE_IF_E2E = "needs.e2e-install.result == 'success'"
RELEASE_PATH = ".github/workflows/release.yml"
E2E_PATH = ".github/workflows/e2e-install.yml"
CI_USES = "./.github/workflows/ci.yml"
E2E_PR_PATHS = ("apps/api/**", "apps/web/Dockerfile", "deploy/images/**", "VERSION")
E2E_DISPATCH_INPUTS = ("tag", "promote", "skip_e2e")
# Dấu promote — phải khớp apps/genh/internal/selfupdate PromotedMarker
# ("<!-- genh:promoted_at=" + RFC 3339 UTC giây + " -->").
PROMOTED_MARKER_PREFIX = "<!-- genh:promoted_at="
PROMOTED_MARKER_DATE = "date -u +%Y-%m-%dT%H:%M:%SZ"


def load(root: Path, rel: str) -> dict[Any, Any]:
    p = root / rel
    if not p.is_file():
        print(
            f"check_release_gate: không thấy {rel} (root={root}) — chạy từ gốc repo hoặc truyền --root.",
            file=sys.stderr,
        )
        sys.exit(2)
    with p.open(encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        print(f"check_release_gate: {rel} không phải một workflow YAML hợp lệ.", file=sys.stderr)
        sys.exit(2)
    return data


def triggers(wf: dict[Any, Any]) -> dict[Any, Any]:
    """Khối `on:` — PyYAML (YAML 1.1) đọc khoá `on` thành True."""
    on = wf.get("on", wf.get(True))
    if isinstance(on, dict):
        return on
    if isinstance(on, list):
        return {k: None for k in on}
    if isinstance(on, str):
        return {on: None}
    return {}


def as_list(v: Any) -> list[Any]:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def is_true(v: Any) -> bool:
    # `with:` của action được GitHub ép về chuỗi — true và "true" như nhau.
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def is_false(v: Any) -> bool:
    return v is False or (isinstance(v, str) and v.strip().lower() == "false")


def run_scripts(job: dict[Any, Any]) -> list[str]:
    """Nội dung `run:` của từng bước trong job."""
    return [str(st.get("run", "")) for st in job.get("steps") or [] if isinstance(st, dict)]


def joined_commands(script: str) -> list[str]:
    """Các dòng lệnh shell sau khi nối dòng tiếp nối (dấu \\ cuối dòng)."""
    return script.replace("\\\n", " ").splitlines()


def check_ci(ci: dict[Any, Any], path: str = CI_PATH, job: str = "ci") -> list[str]:
    """Workflow gọi lại được từ release.yml (ci.yml → job `ci`, installer-matrix.yml → job `installer`)."""
    errs: list[str] = []
    on = triggers(ci)
    wc = on.get("workflow_call")
    inputs = (wc or {}).get("inputs") if isinstance(wc, dict) else None
    if not isinstance(inputs, dict) or "from_release" not in inputs:
        errs.append(
            f"{path}: thiếu on.workflow_call.inputs.from_release — release.yml (job {job}) không gọi lại được "
            "workflow này; thêm workflow_call với input boolean from_release (mặc định false)."
        )
    conc = ci.get("concurrency")
    group = conc.get("group") if isinstance(conc, dict) else conc
    if not isinstance(group, str) or "from_release" not in group:
        errs.append(
            f"{path}: nhóm concurrency không nhắc from_release — lượt gọi từ Release sẽ chung nhóm với lượt của "
            "push main và bị huỷ ngang (cancel-in-progress); đặt nhóm riêng theo run_id khi from_release."
        )
    return errs


def check_release(rel: dict[Any, Any]) -> list[str]:
    errs: list[str] = []
    jobs = rel.get("jobs") or {}
    ci_job = jobs.get("ci")
    if not isinstance(ci_job, dict) or ci_job.get("uses") != CI_USES:
        errs.append(
            f"{RELEASE_PATH}: thiếu job `ci` với `uses: {CI_USES}` — "
            "Release sẽ phát hành mà không chờ CI trên đúng commit."
        )
    elif not is_true((ci_job.get("with") or {}).get("from_release")):
        errs.append(f"{RELEASE_PATH}: job `ci` phải truyền `with: {{ from_release: true }}` cho ci.yml.")
    inst_job = jobs.get("installer")
    if not isinstance(inst_job, dict) or inst_job.get("uses") != INSTALLER_USES:
        errs.append(
            f"{RELEASE_PATH}: thiếu job `installer` với `uses: {INSTALLER_USES}` — "
            "Release sẽ phát hành mà không chờ go vet/go test genh trên 4 hệ điều hành."
        )
    elif not is_true((inst_job.get("with") or {}).get("from_release")):
        errs.append(f"{RELEASE_PATH}: job `installer` phải truyền `with: {{ from_release: true }}`.")

    build_images = jobs.get("build-images")
    if isinstance(build_images, dict):
        for st in build_images.get("steps") or []:
            if not isinstance(st, dict):
                continue
            tags = str((st.get("with") or {}).get("tags") or "")
            if any(t.strip().endswith(":latest") for t in tags.splitlines()):
                errs.append(
                    f"{RELEASE_PATH}: build-images gắn tag ảnh `:latest` — job này chạy trước CI/E2E nên ai kéo "
                    "`gen-harness-*:latest` sẽ nhận ảnh chưa qua cổng; chỉ đẩy `:<version>`, `:latest` gắn ở job "
                    "promote (e2e-install.yml)."
                )

    release_job = jobs.get("release")
    if not isinstance(release_job, dict):
        errs.append(f"{RELEASE_PATH}: không thấy job `release`.")
        return errs
    if "ci" not in as_list(release_job.get("needs")):
        errs.append(
            f"{RELEASE_PATH}: job `release` không có 'ci' trong needs — "
            "CI đỏ vẫn tạo được Release; thêm 'ci' vào needs."
        )
    if "installer" not in as_list(release_job.get("needs")):
        errs.append(
            f"{RELEASE_PATH}: job `release` không có 'installer' trong needs — "
            "ma trận trình cài (go vet/go test 4 hệ điều hành) đỏ vẫn tạo được Release; thêm 'installer' vào needs."
        )

    gh_release_steps = [
        s
        for s in release_job.get("steps") or []
        if isinstance(s, dict) and str(s.get("uses", "")).startswith("softprops/action-gh-release")
    ]
    if not gh_release_steps:
        errs.append(f"{RELEASE_PATH}: job `release` không có bước softprops/action-gh-release.")
    else:
        steps = [st for st in release_job.get("steps") or [] if isinstance(st, dict)]
        guard_idx = next((i for i, st in enumerate(steps) if st.get("id") == TAG_GUARD_ID), None)
        first_gh = steps.index(gh_release_steps[0])
        guard_run = str(steps[guard_idx].get("run", "")) if guard_idx is not None else ""
        if guard_idx is None or guard_idx > first_gh or "ls-remote" not in guard_run or "prerelease" not in guard_run:
            errs.append(
                f"{RELEASE_PATH}: job `release` thiếu bước `id: {TAG_GUARD_ID}` (git ls-remote tag + kiểm prerelease) "
                "ĐỨNG TRƯỚC softprops/action-gh-release — Re-run có thể ghi đè Release của commit khác hoặc bản đã promote."
            )
    for s in gh_release_steps:
        w = s.get("with") or {}
        if not is_true(w.get("prerelease")):
            errs.append(
                f"{RELEASE_PATH}: bước softprops/action-gh-release phải có `prerelease: true` "
                f"(hiện: {w.get('prerelease')!r}) — Release mới phải là bản thử cho tới khi E2E xanh."
            )
        if not is_false(w.get("make_latest")):
            errs.append(
                f'{RELEASE_PATH}: bước softprops/action-gh-release phải có `make_latest: "false"` '
                f"(hiện: {w.get('make_latest')!r}) — không được đổi bản chính thức (latest) trước khi E2E xanh."
            )
    return errs


def check_e2e(e2e: dict[Any, Any]) -> list[str]:
    errs: list[str] = []
    jobs = e2e.get("jobs") or {}
    promote = jobs.get("promote")
    if not isinstance(promote, dict):
        errs.append(f"{E2E_PATH}: thiếu job `promote` — bản thử sẽ không bao giờ được nâng thành bản chính thức.")
    else:
        perms = promote.get("permissions")
        if not isinstance(perms, dict) or perms.get("contents") != "write":
            errs.append(
                f"{E2E_PATH}: job `promote` cần `permissions: {{ contents: write }}` để sửa Release (gh release edit)."
            )
        if PROMOTE_IF_E2E not in str(promote.get("if", "")):
            errs.append(
                f"{E2E_PATH}: `if` của job `promote` không đòi `{PROMOTE_IF_E2E}` — promote có thể chạy khi E2E cài "
                "thật đỏ/bị bỏ qua (always())."
            )
        needs = as_list(promote.get("needs"))
        for j in ("e2e-install", "e2e-upgrade"):
            if j not in needs:
                errs.append(f"{E2E_PATH}: job `promote` thiếu '{j}' trong needs — có thể promote khi E2E chưa xanh.")
        errs += check_promote_marker(promote)

    selfupd = jobs.get("e2e-selfupdate")
    if not isinstance(selfupd, dict) or "promote" not in as_list(selfupd.get("needs")):
        errs.append(
            f"{E2E_PATH}: thiếu job `e2e-selfupdate` (needs promote) — không còn E2E nào đi đường genh cũ tự tải "
            "genh mới qua releases/latest (đường mọi máy Owner nâng cấp)."
        )
    else:
        errs += check_selfupdate_rollback(selfupd)

    on = triggers(e2e)
    wd = on.get("workflow_dispatch")
    wd_inputs = (wd or {}).get("inputs") if isinstance(wd, dict) else None
    for name in E2E_DISPATCH_INPUTS:
        if not isinstance(wd_inputs, dict) or name not in wd_inputs:
            errs.append(f"{E2E_PATH}: workflow_dispatch thiếu input `{name}` (hợp đồng: tag, promote, skip_e2e).")

    pr = on.get("pull_request")
    paths = (pr or {}).get("paths") if isinstance(pr, dict) else None
    paths = as_list(paths)
    for want in E2E_PR_PATHS:
        if want not in paths:
            errs.append(
                f"{E2E_PATH}: bộ lọc paths của pull_request thiếu '{want}' — "
                "PR đổi phần này sẽ không chạy E2E cài thật."
            )
    return errs


def check_selfupdate_rollback(job: dict[Any, Any]) -> list[str]:
    """e2e-selfupdate đỏ (bản đã là latest) ⇒ phải TỰ lùi latest về PREV_TAG rồi kiểm lại, không chỉ in hướng dẫn."""
    errs: list[str] = []
    perms = job.get("permissions")
    if not isinstance(perms, dict) or perms.get("contents") != "write":
        errs.append(
            f"{E2E_PATH}: job `e2e-selfupdate` cần `permissions: {{ contents: write }}` để bước rollback sửa Release."
        )
    ok = False
    for st in job.get("steps") or []:
        if not isinstance(st, dict) or "failure()" not in str(st.get("if", "")):
            continue
        cmds = [ln for ln in joined_commands(str(st.get("run", ""))) if not ln.lstrip().startswith(("#", "echo"))]
        has_pre = any("gh release edit" in ln and "$TAG" in ln and "--prerelease=true" in ln for ln in cmds)
        has_latest = any("gh release edit" in ln and "$PREV_TAG" in ln and "--latest" in ln for ln in cmds)
        has_check = any("releases/latest" in ln for ln in cmds) and any("exit 1" in ln for ln in cmds)
        if has_pre and has_latest and has_check:
            ok = True
    if not ok:
        errs.append(
            f"{E2E_PATH}: job `e2e-selfupdate` thiếu bước `if: failure()` TỰ lùi bản chính thức "
            '(`gh release edit "$TAG" --prerelease=true`, `gh release edit "$PREV_TAG" --latest`, kiểm releases/latest '
            "== PREV_TAG, sai thì exit 1) — máy Owner sẽ tự cài bản lỗi sau 24 giờ."
        )
    return errs


def check_promote_marker(promote: dict[Any, Any]) -> list[str]:
    """Promote phải ghi dấu promoted_at trong CÙNG lệnh nâng latest (một PATCH — không có lúc bản đã là latest mà
    chưa có dấu, khi đó lịch đêm tính 24 giờ từ published_at = lúc tạo bản thử)."""
    scripts = run_scripts(promote)
    text = "\n".join(scripts)
    errs: list[str] = []
    if PROMOTED_MARKER_PREFIX not in text or PROMOTED_MARKER_DATE not in text:
        errs.append(
            f"{E2E_PATH}: job `promote` không ghi dấu `{PROMOTED_MARKER_PREFIX}…-->` bằng `{PROMOTED_MARKER_DATE}` vào "
            "ghi chú Release — thời gian chín 24 giờ sẽ tính từ published_at (lúc tạo bản thử), bản promote muộn lọt "
            "cổng ngay đêm đó. Định dạng phải khớp selfupdate.PromotedMarker."
        )
    edits = [
        line
        for sc in scripts
        for line in joined_commands(sc)
        if "gh release edit" in line and "--latest" in line and not line.lstrip().startswith(("#", "echo"))
    ]
    if not any("--notes-file" in line for line in edits):
        errs.append(
            f"{E2E_PATH}: job `promote` phải nâng latest và ghi dấu promoted_at trong CÙNG một lệnh "
            "`gh release edit <tag> --prerelease=false --latest --notes-file <ghi chú có dấu>`."
        )
    return errs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Kiểm bất biến cổng phát hành (release.yml / ci.yml / e2e-install.yml).")
    ap.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="thư mục gốc repo (mặc định: suy từ vị trí script)",
    )
    args = ap.parse_args(argv)
    root: Path = args.root

    errs = (
        check_ci(load(root, CI_PATH))
        + check_ci(load(root, INSTALLER_PATH), INSTALLER_PATH, "installer")
        + check_release(load(root, RELEASE_PATH))
        + check_e2e(load(root, E2E_PATH))
    )
    if errs:
        print(f"Cổng phát hành: {len(errs)} lỗi bất biến:", file=sys.stderr)
        for e in errs:
            print(f"::error::{e}", file=sys.stderr)
        return 1
    print("Cổng phát hành OK: CI xanh → bản thử (prerelease) → E2E đúng tag → promote latest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
