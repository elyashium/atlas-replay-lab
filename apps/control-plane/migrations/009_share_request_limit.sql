CREATE TABLE shared_report_request_buckets (
  share_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (share_id, bucket_start)
);
CREATE INDEX shared_report_request_buckets_expiry_idx
  ON shared_report_request_buckets(bucket_start);
