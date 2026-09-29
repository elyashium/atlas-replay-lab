DROP INDEX visual_reviews_source_run_idx;
ALTER TABLE visual_reviews
  DROP CONSTRAINT visual_reviews_source_pair_check,
  DROP COLUMN source_artifact_name,
  DROP COLUMN source_artifact_id,
  DROP COLUMN source_run_id;
