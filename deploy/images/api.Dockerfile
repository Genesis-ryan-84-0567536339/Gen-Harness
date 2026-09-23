# Một image cho api, worker và bước migrate. Build từ gốc repo: docker build -f deploy/images/api.Dockerfile .
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/apps/api
COPY apps/api/pyproject.toml ./
COPY apps/api/gh ./gh
RUN pip install .
COPY apps/api/alembic.ini ./
COPY apps/api/migrations ./migrations
COPY db/sql /app/db/sql
COPY plugins /app/plugins
RUN useradd --system --uid 10001 --home-dir /home/gh --create-home gh
USER gh
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health').status==200 else 1)"
CMD ["gh-api"]
