DROP INDEX IF EXISTS visual_reviews_reference_run_idx;
ALTER TABLE visual_reviews
  DROP CONSTRAINT IF EXISTS visual_reviews_reference_pair_check,
  DROP COLUMN IF EXISTS reference_artifact_name,
  DROP COLUMN IF EXISTS reference_artifact_id,
  DROP COLUMN IF EXISTS reference_run_id;
