CREATE TABLE visual_review_usage (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 1000),
  PRIMARY KEY (organization_id, usage_date)
);

CREATE TABLE visual_reviews (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('complete', 'inconclusive')),
  provider text NOT NULL CHECK (provider = 'groq'),
  requested_model text NOT NULL,
  returned_model text,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  screenshot_sha256 text NOT NULL CHECK (screenshot_sha256 ~ '^[0-9a-f]{64}$'),
  reference_sha256 text CHECK (reference_sha256 IS NULL OR reference_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  result jsonb NOT NULL,
  error text,
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX visual_reviews_project_idx ON visual_reviews(organization_id, project_id, created_at DESC);
CREATE INDEX visual_reviews_retention_idx ON visual_reviews(retention_expires_at);
