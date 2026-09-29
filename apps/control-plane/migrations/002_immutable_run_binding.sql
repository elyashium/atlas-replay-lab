-- Older queue rows were accepted before build/policy binding was enforced.
-- They are request records, not browser runs; cancel them so a future worker
-- cannot mistake unbound rows for executable release checks.
UPDATE runs
SET status='cancelled', finished_at=COALESCE(finished_at, now())
WHERE status='queued';

ALTER TABLE runs ADD COLUMN binding_snapshot jsonb;
UPDATE runs
SET binding_snapshot='{"bindingVersion":0,"bindingHash":"0000000000000000"}'::jsonb
WHERE binding_snapshot IS NULL;
ALTER TABLE runs ALTER COLUMN binding_snapshot SET NOT NULL;
ALTER TABLE runs ADD CONSTRAINT runs_binding_snapshot_object
  CHECK (
    jsonb_typeof(binding_snapshot)='object'
    AND jsonb_typeof(binding_snapshot->'bindingVersion')='number'
    AND binding_snapshot->>'bindingHash' ~ '^[0-9a-f]{16}$'
  );
