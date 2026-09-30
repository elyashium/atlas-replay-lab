ALTER TABLE visual_reviews
  ADD COLUMN reference_run_id uuid,
  ADD COLUMN reference_artifact_id uuid,
  ADD COLUMN reference_artifact_name text,
  ADD CONSTRAINT visual_reviews_reference_pair_check CHECK (
    (reference_run_id IS NULL AND reference_artifact_id IS NULL AND reference_artifact_name IS NULL)
    OR
    (reference_run_id IS NOT NULL AND reference_artifact_id IS NOT NULL AND reference_artifact_name IS NOT NULL)
  );

CREATE INDEX visual_reviews_reference_run_idx
  ON visual_reviews(organization_id, reference_run_id)
  WHERE reference_run_id IS NOT NULL;
