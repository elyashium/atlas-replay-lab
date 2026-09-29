-- Reverting removes immutable provenance from run records. Only use against a
-- disposable local database or after exporting the evidence rows.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_binding_snapshot_object;
ALTER TABLE runs DROP COLUMN IF EXISTS binding_snapshot;
DELETE FROM schema_migrations WHERE version='002_immutable_run_binding';
