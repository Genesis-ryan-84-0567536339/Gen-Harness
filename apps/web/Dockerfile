# Gen-Harness web console. Build from the REPO ROOT (the app builds from the
# shared packages/* workspaces):
#   docker build -f apps/web/Dockerfile -t gen-harness/web .
# Serves the static bundle on :8080 (nginx-unprivileged, non-root) with SPA fallback.

# ── build ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo
ENV CI=1 NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
# manifests first for layer caching
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
COPY packages/tokens/package.json packages/tokens/
COPY packages/ui/package.json packages/ui/
COPY packages/contracts/package.json packages/contracts/
RUN if [ -f package-lock.json ]; then \
      npm ci --workspace @gen-harness/web --include-workspace-root=false --ignore-scripts; \
    else \
      npm install --workspace @gen-harness/web --ignore-scripts; \
    fi
COPY packages/ packages/
COPY apps/web/ apps/web/
# vite.config gói kèm mock (test/mock-*.ts), mock đọc dữ liệu mẫu của thiết kế.
COPY docs/design/seed-data.json docs/design/seed-data.json
RUN npm run build --workspace @gen-harness/web

# ── serve ──────────────────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
USER 101
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
