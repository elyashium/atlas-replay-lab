-- Aggregate public share traffic by route and minute. No client IP, token, or
-- user agent is stored. This is a coarse service ceiling, not per-client fairness.
CREATE TABLE anonymous_share_request_buckets (
  route text NOT NULL CHECK (route IN ('open', 'artifact')),
  bucket_start timestamptz NOT NULL,
  request_count bigint NOT NULL CHECK (request_count > 0),
  PRIMARY KEY (route, bucket_start)
);
CREATE INDEX anonymous_share_request_buckets_expiry_idx
  ON anonymous_share_request_buckets(bucket_start);
