# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# PostgreSQL 16 + pgvector + pg_partman (ARCHITECTURE §2).
# ghim digest (F-19) — Renovate tự nâng
FROM pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-partman \
 && rm -rf /var/lib/apt/lists/*
CMD ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]
