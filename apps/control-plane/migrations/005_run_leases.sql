ALTER TABLE runs
  ADD COLUMN worker_id text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN error_code text,
  ADD COLUMN result_snapshot jsonb;

CREATE INDEX runs_expired_lease_idx ON runs(lease_expires_at) WHERE status='running';
