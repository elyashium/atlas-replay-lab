DROP INDEX IF EXISTS runs_expired_lease_idx;
ALTER TABLE runs
  DROP COLUMN IF EXISTS worker_id,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS attempt_count,
  DROP COLUMN IF EXISTS error_code,
  DROP COLUMN IF EXISTS result_snapshot;
