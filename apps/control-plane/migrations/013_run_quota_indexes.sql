CREATE INDEX runs_org_created_quota_idx ON runs(organization_id, created_at DESC);
CREATE INDEX runs_org_active_quota_idx ON runs(organization_id, retention_expires_at) WHERE status IN ('queued','running');
