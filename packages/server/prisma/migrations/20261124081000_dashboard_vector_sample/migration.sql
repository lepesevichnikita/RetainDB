-- The hash is a bounded index key; readers also compare the full model name.
CREATE INDEX CONCURRENTLY chunks_dashboard_vector_sample_idx ON chunks
    (md5(NULLIF(metadata->>'embedding_model', '')), "createdAt" DESC, id)
    WHERE embedding IS NOT NULL AND COALESCE(metadata->>'content_kind', '') <> 'parent_context';
