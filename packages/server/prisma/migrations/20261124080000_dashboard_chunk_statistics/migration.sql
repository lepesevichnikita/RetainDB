BEGIN;

-- Store counts only. Dashboard queries recheck live project, source, and publication visibility.
CREATE MATERIALIZED VIEW dashboard_chunk_statistics AS
WITH by_model AS (
    SELECT "documentId", "projectId", NULLIF(metadata->>'embedding_model', '') AS model,
           count(*)::int AS chunks, count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
    FROM chunks
    WHERE "projectId" IS NOT NULL AND COALESCE(metadata->>'content_kind', '') <> 'parent_context'
    GROUP BY "documentId", "projectId", model
)
SELECT m."documentId", m."projectId", d."sourceId", d."sourceVersionId",
       sum(m.chunks)::int AS chunks, sum(m.embedded)::int AS embedded,
       COALESCE(jsonb_agg(jsonb_build_object('model', m.model, 'count', m.embedded)
                          ORDER BY m.model) FILTER (WHERE m.embedded > 0), '[]'::jsonb) AS models
FROM by_model m JOIN documents d ON d.id = m."documentId"
GROUP BY m."documentId", m."projectId", d."sourceId", d."sourceVersionId";

CREATE UNIQUE INDEX dashboard_chunk_statistics_document_project_idx
    ON dashboard_chunk_statistics ("documentId", "projectId");
CREATE INDEX dashboard_chunk_statistics_project_idx ON dashboard_chunk_statistics ("projectId");

CREATE TABLE dashboard_statistics_refresh (
    singleton boolean PRIMARY KEY CHECK (singleton),
    counts_as_of timestamptz NOT NULL
);
INSERT INTO dashboard_statistics_refresh (singleton, counts_as_of) VALUES (true, transaction_timestamp());

COMMIT;
