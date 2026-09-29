CREATE TABLE visual_finding_dispositions (
  organization_id uuid NOT NULL,
  visual_review_id uuid NOT NULL,
  finding_index smallint NOT NULL CHECK (finding_index BETWEEN 0 AND 4),
  disposition text NOT NULL CHECK (disposition IN ('confirmed', 'accepted-risk', 'false-positive', 'needs-follow-up')),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, visual_review_id, finding_index),
  FOREIGN KEY (organization_id, visual_review_id)
    REFERENCES visual_reviews(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX visual_finding_dispositions_review_idx
  ON visual_finding_dispositions(organization_id, visual_review_id);
