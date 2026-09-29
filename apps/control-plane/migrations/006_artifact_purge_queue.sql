CREATE TABLE artifact_purge_queue (
  run_id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now()
);
