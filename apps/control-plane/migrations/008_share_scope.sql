ALTER TABLE share_links
  ADD COLUMN include_summary boolean NOT NULL DEFAULT false,
  ADD COLUMN artifact_scope jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_scope) = 'array'),
  ADD COLUMN access_count integer NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  ADD COLUMN last_accessed_at timestamptz;
