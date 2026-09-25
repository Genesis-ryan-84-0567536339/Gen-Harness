# Một image cho api, worker và bước migrate. Build từ gốc repo: docker build -f deploy/images/api.Dockerfile .
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/apps/api

# Antigravity CLI chính hãng của Google (quyết định Q6): tải đúng bản phát hành, kiểm SHA-256 ghim sẵn, không đóng gói lại.
# Nguồn: https://github.com/google-antigravity/antigravity-cli/releases (tệp agy_cli_linux_<arch>.tar.gz chứa `antigravity`).
ARG AGY_VERSION=1.2.9
ARG AGY_SHA256_AMD64=d9850373f3df866011024a961fa9740cc4adaac060eebe9c70fbf263ac6b2624
ARG AGY_SHA256_ARM64=8a63cf4c4f559e2ff91bd46fbdf015ca7937415805d0cff82015b9cb9dbbdfcd
ARG TARGETARCH
RUN set -eux; \
    apt-get update; apt-get install -y --no-install-recommends ca-certificates curl; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x64; sum="$AGY_SHA256_AMD64" ;; \
      arm64) arch=arm64; sum="$AGY_SHA256_ARM64" ;; \
      *) echo "Kiến trúc chưa hỗ trợ: $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/agy.tgz "https://github.com/google-antigravity/antigravity-cli/releases/download/${AGY_VERSION}/agy_cli_linux_${arch}.tar.gz"; \
    echo "$sum  /tmp/agy.tgz" | sha256sum -c -; \
    tar -xzf /tmp/agy.tgz -C /usr/local/bin antigravity; \
    chmod 0755 /usr/local/bin/antigravity; ln -s /usr/local/bin/antigravity /usr/local/bin/agy; \
    rm -f /tmp/agy.tgz; apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*
COPY apps/api/pyproject.toml ./
COPY apps/api/gh ./gh
RUN pip install .
COPY apps/api/alembic.ini ./
COPY apps/api/migrations ./migrations
COPY db/sql /app/db/sql
COPY plugins /app/plugins
RUN useradd --system --uid 10001 --home-dir /home/gh --create-home gh \
    && mkdir -p /var/lib/gh/agy/.gemini/antigravity-cli && chown -R gh:gh /var/lib/gh
ENV GH_CLI_HOME=/var/lib/gh/agy/.gemini/antigravity-cli GH_CLI_BINARY=agy AGY_CLI_DISABLE_AUTO_UPDATE=1
USER gh
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health').status==200 else 1)"
CMD ["gh-api"]
