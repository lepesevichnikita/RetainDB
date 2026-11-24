import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const fixture = pathToFileURL(fileURLToPath(new URL("./fixtures/embedding-worker.ts", import.meta.url))).toString();
process.env.RETAINDB_EMBEDDING_WORKER_ENTRY = fixture;
delete process.env.RETAINDB_EMBEDDING_WORKER;

test("embeddings are produced by a separate process and mark the worker ready", async (t) => {
  const { requestEmbeddings, embeddingWorkerState, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  t.after(() => stopEmbeddingWorker());

  assert.equal(embeddingWorkerState(), "cold");
  const vectors = await requestEmbeddings(["alpha", "beta"]);

  assert.deepEqual(vectors, [[5, 1], [4, 1]]);
  assert.equal(embeddingWorkerState(), "ready");
});

test("concurrent callers share one worker without receiving each other's vectors", async (t) => {
  const { requestEmbeddings, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  t.after(() => stopEmbeddingWorker());

  const [slow, fast, secondSlow] = await Promise.all([
    requestEmbeddings(["slow"]),
    requestEmbeddings(["fast"]),
    requestEmbeddings(["slow"]),
  ]);

  assert.deepEqual(slow, [[4, 1]]);
  assert.deepEqual(fast, [[4, 1]]);
  assert.deepEqual(secondSlow, [[4, 1]]);
});

test("one failed request rejects only that caller and the next success restores readiness", async (t) => {
  const { requestEmbeddings, embeddingWorkerState, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  t.after(() => stopEmbeddingWorker());

  await assert.rejects(requestEmbeddings(["explode"]), /fixture inference failed/);
  assert.equal(embeddingWorkerState(), "failed");
  assert.deepEqual(await requestEmbeddings(["fine"]), [[4, 1]]);
  assert.equal(embeddingWorkerState(), "ready");
});

test("a timed-out request reports failure, kills the stuck worker, and the next call reloads it", async (t) => {
  const { requestEmbeddings, embeddingWorkerState, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  t.after(() => stopEmbeddingWorker());

  await assert.rejects(requestEmbeddings(["hang"], { timeoutMs: 200 }), /timed out/i);
  assert.equal(embeddingWorkerState(), "failed");
  assert.deepEqual(await requestEmbeddings(["after"]), [[5, 1]]);
  assert.equal(embeddingWorkerState(), "ready");
});

test("an aborted caller does not block later work", async (t) => {
  const { requestEmbeddings, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  t.after(() => stopEmbeddingWorker());

  const controller = new AbortController();
  const pending = requestEmbeddings(["slow"], { signal: controller.signal });
  controller.abort(new Error("caller went away"));

  await assert.rejects(pending, /caller went away/);
  assert.deepEqual(await requestEmbeddings(["next"]), [[4, 1]]);
});

test("warming the worker reports ready", async (t) => {
  const { warmEmbeddings, embeddingWorkerState, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  t.after(() => stopEmbeddingWorker());

  await warmEmbeddings();
  assert.equal(embeddingWorkerState(), "ready");
});

test("reranking runs in the same worker instead of blocking the API process", async (t) => {
  const { scoreInProcess, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  t.after(() => stopEmbeddingWorker());

  const scores = await scoreInProcess("query", ["short", "a much longer passage"]);
  assert.equal(scores.length, 2);
  assert.ok(Math.abs(scores[1] - scores[0]) > 0);
});

test("a dying embedding process is reported without taking the caller down", async (t) => {
  const { requestEmbeddings, embeddingWorkerState, stopEmbeddingWorker } = await import("../src/engine/embedding-process.js");
  t.after(async () => {
    delete process.env.RETAINDB_FIXTURE_EXIT_IMMEDIATELY;
    await stopEmbeddingWorker();
  });

  process.env.RETAINDB_FIXTURE_EXIT_IMMEDIATELY = "1";
  await assert.rejects(requestEmbeddings(["boom"]), /exited|restarted|channel|closed/i);
  assert.equal(embeddingWorkerState(), "failed");

  delete process.env.RETAINDB_FIXTURE_EXIT_IMMEDIATELY;
  assert.deepEqual(await requestEmbeddings(["ok"]), [[2, 1]]);
  assert.equal(embeddingWorkerState(), "ready");
});

test("a caller that awaits only the embedding stays alive until the answer arrives", async () => {
  // The worker is unref'd while idle so a CLI can exit; it has to be ref'd while
  // a request is pending, or the process exits and the pending test is cancelled
  // with "the event loop has already resolved".
  const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/engine/embedding-process.ts", import.meta.url))).toString();
  const script = `import { requestEmbeddings } from ${JSON.stringify(moduleUrl)};
const vectors = await requestEmbeddings(["keepalive-text"]);
console.log(JSON.stringify(vectors));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, RETAINDB_EMBEDDING_WORKER_ENTRY: fixture },
    timeout: 30_000,
  });

  assert.deepEqual(JSON.parse(stdout.trim().split("\n").pop()!), [[14, 1]]);
});
