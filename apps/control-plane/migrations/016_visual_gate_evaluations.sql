ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_organization_id_id_unique UNIQUE (organization_id, id);

CREATE TABLE visual_gate_evaluations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  reference_run_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  reference_artifact_id uuid NOT NULL,
  relative_path text NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 1024),
  verdict text NOT NULL CHECK (verdict IN ('SHIP', 'HOLD', 'INCONCLUSIVE')),
  policy_snapshot jsonb NOT NULL,
  evidence jsonb NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id, project_id)
    REFERENCES projects(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, run_id)
    REFERENCES runs(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, reference_run_id)
    REFERENCES runs(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, artifact_id)
    REFERENCES artifacts(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, reference_artifact_id)
    REFERENCES artifacts(organization_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, run_id, reference_run_id, relative_path)
);
CREATE INDEX visual_gate_project_idx
  ON visual_gate_evaluations(organization_id, project_id, created_at DESC);
CREATE INDEX visual_gate_retention_idx
  ON visual_gate_evaluations(retention_expires_at);
