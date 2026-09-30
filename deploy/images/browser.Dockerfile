# browser-worker + proxy ra ngoài (v0.1.29, docs/design/gen-browser-agent.md §3.1). Build từ gốc repo:
#   docker build -f deploy/images/browser.Dockerfile .
# Ảnh gốc Playwright chính thức (Chromium + Xvfb + phông), GHIM DIGEST của danh sách đa kiến trúc (amd64 + arm64) —
# thư viện `playwright` phải cùng phiên bản (apps/browser/pyproject.toml) để khớp bản Chromium đi kèm.
# Đổi phiên bản: lấy digest mới bằng
#   curl -sI -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
#     https://mcr.microsoft.com/v2/playwright/python/manifests/v<phiên bản>-noble | grep -i docker-content-digest
# Không cài plugin "stealth", không đổi user agent/vân tay trình duyệt (luật cứng — xem gh/social/platforms.py).
FROM mcr.microsoft.com/playwright/python:v1.56.0-noble@sha256:a7f6cf3ae520c9d670ad956572c13747ed5abdbba5123a01526f873ed1662528
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOME=/tmp
WORKDIR /app
COPY apps/browser/pyproject.toml ./
COPY apps/browser/ghb ./ghb
RUN pip install --break-system-packages --no-cache-dir . \
 && python3 -c "import ghb, ghb.worker, ghb.egress, playwright, redis, orjson; print('ghb', ghb.__version__)"
# Không root. rootfs chỉ-đọc + tmpfs /tmp đặt ở compose (hồ sơ trình duyệt chỉ sống trong RAM, xoá khi xong việc).
USER pwuser
# Trình duyệt chạy CÓ giao diện trong màn hình ảo Xvfb (như trình duyệt thường), không phải chế độ headless.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x800x24 -nolisten tcp", "python3", "-m", "ghb.worker"]
