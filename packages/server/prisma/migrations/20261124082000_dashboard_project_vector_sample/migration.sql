-- Use the project and model together so a sparse project need not scan a popular model globally.
CREATE INDEX CONCURRENTLY chunks_dashboard_project_vector_sample_idx ON chunks
    ("projectId", md5(NULLIF(metadata->>'embedding_model', '')), "createdAt" DESC, id)
    WHERE embedding IS NOT NULL AND COALESCE(metadata->>'content_kind', '') <> 'parent_context';
