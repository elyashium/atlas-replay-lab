ALTER TABLE visual_reviews
  ADD COLUMN source_run_id uuid,
  ADD COLUMN source_artifact_id uuid,
  ADD COLUMN source_artifact_name text,
  ADD CONSTRAINT visual_reviews_source_pair_check CHECK (
    (source_run_id IS NULL AND source_artifact_id IS NULL AND source_artifact_name IS NULL)
    OR
    (source_run_id IS NOT NULL AND source_artifact_id IS NOT NULL AND source_artifact_name IS NOT NULL)
  );

CREATE INDEX visual_reviews_source_run_idx
  ON visual_reviews(organization_id, source_run_id)
  WHERE source_run_id IS NOT NULL;
