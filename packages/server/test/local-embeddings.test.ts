import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Recall and native capture must share one model session, and that session must
 * live in the embedding process. These vectors arrive over IPC from the child,
 * so the test also proves the API process is not loading ONNX itself.
 */
test("local recall and native capture share one embedding process", {
  skip: process.env.RETAINDB_TEST_LOCAL_EMBEDDINGS !== "true",
  timeout: 180_000,
}, async (context) => {
  const previousMode = process.env.EMBEDDING_MODE;
  process.env.EMBEDDING_MODE = "local";
  const { embedLocal } = await import("../src/engine/embeddings-local.js");
  const { embedNativeCapture } = await import("../src/engine/native-embeddings.js");
  const { embeddingWorkerState, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  context.after(async () => {
    if (previousMode === undefined) delete process.env.EMBEDDING_MODE;
    else process.env.EMBEDDING_MODE = previousMode;
    await stopEmbeddingWorker();
  });

  const texts = [
    "Verify PostgreSQL database backup checksums before restoring a database.",
    "Check the database backup checksum before PostgreSQL recovery.",
    "Fresh strawberries and whipped cream make a summer dessert.",
  ];
  // A queued hook can race the first query on cold start. Both must use the same model session.
  const [vectors, captured, concurrentQuery] = await Promise.all([
    embedLocal(texts), embedNativeCapture([texts[0]]), embedLocal([texts[0]]),
  ]);

  assert.equal(vectors.length, 3);
  assert.deepEqual(captured[0], vectors[0]);
  assert.deepEqual(concurrentQuery[0], vectors[0]);
  for (const vector of vectors) {
    assert.equal(vector.length, 1024);
    assert.ok(vector.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.001);
  }
  const similarity = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index], 0);
  assert.ok(similarity(vectors[0], vectors[1]) > similarity(vectors[0], vectors[2]));
  assert.equal(embeddingWorkerState(), "ready");
});
