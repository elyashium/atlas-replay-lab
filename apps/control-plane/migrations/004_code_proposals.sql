CREATE TABLE code_proposal_usage (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 1000),
  PRIMARY KEY (organization_id, usage_date)
);

CREATE TABLE code_proposals (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  visual_review_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('proposal', 'no-change', 'inconclusive')),
  provider text NOT NULL CHECK (provider = 'groq'),
  requested_model text NOT NULL,
  returned_model text,
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 128),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  result jsonb NOT NULL,
  error text,
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, visual_review_id)
    REFERENCES visual_reviews(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX code_proposals_project_idx ON code_proposals(organization_id, project_id, created_at DESC);
CREATE INDEX code_proposals_retention_idx ON code_proposals(retention_expires_at);
