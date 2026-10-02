"""F-5 (v0.1.35): CSP của proxy Caddy (lớp quyết định) và nginx đủ chặt;
compose buộc tạo lại proxy khi Caddyfile đổi."""

import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).parents[3]
CADDYFILE = ROOT / "deploy" / "proxy" / "Caddyfile"


def _directives(csp: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for part in csp.split(";"):
        tokens = part.split()
        if tokens:
            out[tokens[0]] = tokens[1:]
    return out


def _csp_of(path: Path) -> dict[str, list[str]]:
    m = re.search(r'Content-Security-Policy\s+"([^"]+)"', path.read_text())
    assert m, f"{path.name} thiếu Content-Security-Policy"
    return _directives(m.group(1))


def test_caddy_csp_locked_down() -> None:
    d = _csp_of(CADDYFILE)
    assert d["script-src"] == ["'self'"]
    assert d["object-src"] == ["'none'"]
    assert d["base-uri"] == ["'none'"]
    assert d["form-action"] == ["'self'"]
    assert d["frame-ancestors"] == ["'none'"]
    assert "'self'" in d["connect-src"]
    # Không có nguồn WebSocket mở toang; chỉ đúng host:port đang phục vụ (placeholder Caddy).
    assert not {"wss:", "ws:", "*", "https:"} & set(d["connect-src"])
    assert all(t == "'self'" or t == "wss://{http.request.hostport}" for t in d["connect-src"])


def test_compose_label_tracks_caddyfile_hash() -> None:
    sha = hashlib.sha256(CADDYFILE.read_bytes()).hexdigest()[:12]
    compose = (ROOT / "deploy" / "compose.yaml").read_text()
    m = re.search(r'gh\.caddyfile-sha:\s*"([0-9a-f]+)"', compose)
    assert m, "deploy/compose.yaml thiếu nhãn gh.caddyfile-sha cho service proxy"
    assert m.group(1) == sha, f"Sửa Caddyfile thì đổi nhãn gh.caddyfile-sha thành {sha} (và chép sang bản nhúng genh)"


def test_nginx_csp_no_open_websocket() -> None:
    nginx = ROOT / "apps" / "web" / "nginx.conf"
    d = _csp_of(nginx)
    assert "wss:" not in nginx.read_text()
    assert "ws:" not in d["connect-src"] and "'self'" in d["connect-src"]
    assert d["script-src"] == ["'self'"] and d["object-src"] == ["'none'"] and d["base-uri"] == ["'none'"]
