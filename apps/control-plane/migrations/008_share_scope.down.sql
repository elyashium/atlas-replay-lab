ALTER TABLE share_links
  DROP COLUMN last_accessed_at,
  DROP COLUMN access_count,
  DROP COLUMN artifact_scope,
  DROP COLUMN include_summary;
