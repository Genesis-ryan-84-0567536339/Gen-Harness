-- Gen-Harness · v0.1.40 (F-2, F-16): hạn lưu thật + job nặng.
-- - F-16: chỉ mục trigram trên lower(display_name) cho dò trùng danh tính (toán tử `%` dùng được chỉ mục),
--   bảng mốc tiến độ `ops.job_watermarks` (dò trùng chỉ xét định danh mới/hồ sơ vừa sửa).
-- - F-2: chỉ mục hỗ trợ dọn theo lô (gh/retention.py): browser_jobs.result 14 ngày, mục sổ tay đã nén,
--   tệp đính kèm của sự kiện thô đã bị partman xoá theo tháng.
-- Chạy lại an toàn (IF NOT EXISTS / DROP POLICY IF EXISTS), theo khuôn 0024.
-- fastupdate = off: không có "pending list" (danh sách chờ quét tuần tự mỗi lần dò) — hồ sơ mới chèn ít, dò tên
-- chạy mỗi 10 phút nên ưu tiên dò ổn định.
CREATE INDEX IF NOT EXISTS persons_lower_name_trgm_idx ON core.persons USING gin (lower(display_name) gin_trgm_ops)
  WITH (fastupdate = off);
ALTER INDEX core.persons_lower_name_trgm_idx SET (fastupdate = off);

CREATE TABLE IF NOT EXISTS ops.job_watermarks (
  org_id      uuid NOT NULL,
  job         text NOT NULL,
  last_id     uuid,
  last_at     timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, job)
);

ALTER TABLE ops.job_watermarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON ops.job_watermarks;
CREATE POLICY org_isolation ON ops.job_watermarks
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
         OR current_setting('app.org_id', true) IS NULL
         OR current_setting('app.org_id', true) = '')
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
         OR current_setting('app.org_id', true) IS NULL
         OR current_setting('app.org_id', true) = '');

CREATE INDEX IF NOT EXISTS browser_jobs_finished_result_idx ON agent.browser_jobs (finished_at)
  WHERE result IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_entries_archived_idx ON memory.entries (archived_at)
  WHERE archived_at IS NOT NULL AND NOT is_pinned;
CREATE INDEX IF NOT EXISTS attachments_event_received_idx ON raw.attachments (event_received_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gh_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ops.job_watermarks TO gh_app;
  END IF;
END $$;
