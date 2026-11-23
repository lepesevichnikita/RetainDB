CREATE TABLE dashboard_rebuilds (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('knowledge', 'graph')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cursor_id TEXT NOT NULL DEFAULT '',
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  error TEXT
);

CREATE UNIQUE INDEX dashboard_rebuilds_one_active_per_org
ON dashboard_rebuilds (org_id) WHERE status IN ('queued', 'running');

CREATE INDEX dashboard_rebuilds_org_created ON dashboard_rebuilds (org_id, created_at DESC);

CREATE TABLE dashboard_rebuild_items (
  job_id TEXT NOT NULL REFERENCES dashboard_rebuilds(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (job_id, chunk_id)
);
