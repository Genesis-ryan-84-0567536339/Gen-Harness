# PostgreSQL 16 + pgvector + pg_partman (ARCHITECTURE §2).
FROM pgvector/pgvector:pg16
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-partman \
 && rm -rf /var/lib/apt/lists/*
CMD ["postgres", "-c", "shared_preload_libraries=pg_stat_statements"]
