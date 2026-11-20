-- CreateTable
CREATE TABLE "repo_index_scopes" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'default',
    "projectId" TEXT NOT NULL,
    "repoHost" TEXT NOT NULL,
    "repoExternalId" TEXT NOT NULL,
    "worktreePath" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "headCommit" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "policyVersion" TEXT NOT NULL,
    "pipelineVersion" TEXT NOT NULL,
    "activeGeneration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_index_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_index_grants" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "principal" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_index_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_index_generations" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "baseGeneration" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "revision" TEXT NOT NULL,
    "manifestDigest" TEXT NOT NULL,
    "partCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sealedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "receiptDigest" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_index_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_index_parts" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "partNo" INTEGER NOT NULL,
    "requestHash" TEXT NOT NULL,
    "upsertCount" INTEGER NOT NULL DEFAULT 0,
    "tombstoneCount" INTEGER NOT NULL DEFAULT 0,
    "tombstonePaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_index_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_index_paths" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "lineStart" INTEGER,
    "lineEnd" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'present',
    "chunkId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_index_paths_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repo_index_scopes_projectId_idx" ON "repo_index_scopes"("projectId");

-- CreateIndex
CREATE INDEX "repo_index_scopes_state_idx" ON "repo_index_scopes"("state");

-- CreateIndex
CREATE UNIQUE INDEX "repo_index_scopes_orgId_repoHost_repoExternalId_worktreePat_key" ON "repo_index_scopes"("orgId", "repoHost", "repoExternalId", "worktreePath");

-- CreateIndex
CREATE INDEX "repo_index_grants_scopeId_revokedAt_idx" ON "repo_index_grants"("scopeId", "revokedAt");

-- A principal holds at most one live grant per capability; revoked grants are history and must
-- not occupy the key, so a leaked token can be revoked and replaced. The partial predicate is the
-- only exact way to say that: a plain unique key over (scopeId, kind, principal, revokedAt) would
-- treat every live NULL as distinct and allow two live credentials.
CREATE UNIQUE INDEX "repo_index_grants_live_principal_key" ON "repo_index_grants"("scopeId", "kind", "principal") WHERE "revokedAt" IS NULL;

-- CreateIndex
CREATE INDEX "repo_index_generations_scopeId_status_idx" ON "repo_index_generations"("scopeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "repo_index_generations_scopeId_attemptId_key" ON "repo_index_generations"("scopeId", "attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "repo_index_generations_scopeId_generation_key" ON "repo_index_generations"("scopeId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "repo_index_parts_generationId_partNo_key" ON "repo_index_parts"("generationId", "partNo");

-- CreateIndex
CREATE INDEX "repo_index_paths_scopeId_state_idx" ON "repo_index_paths"("scopeId", "state");

-- CreateIndex
CREATE INDEX "repo_index_paths_generationId_idx" ON "repo_index_paths"("generationId");

-- CreateIndex
CREATE UNIQUE INDEX "repo_index_paths_scopeId_path_key" ON "repo_index_paths"("scopeId", "path");

-- AddForeignKey
ALTER TABLE "repo_index_grants" ADD CONSTRAINT "repo_index_grants_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "repo_index_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_index_generations" ADD CONSTRAINT "repo_index_generations_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "repo_index_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_index_parts" ADD CONSTRAINT "repo_index_parts_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "repo_index_generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_index_paths" ADD CONSTRAINT "repo_index_paths_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "repo_index_scopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

