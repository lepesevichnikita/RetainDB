import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Client for the one process that owns the local ONNX models.
 *
 * Loading a quantized model and running inference blocks the JavaScript thread
 * that performs it. The API process therefore never loads a model: it sends
 * work to this child, which keeps /health and every other route answering while
 * embeddings are warming up.
 */

export type EmbeddingWorkerState = "cold" | "warming" | "ready" | "failed";

interface PendingRequest {
  id: string;
  expected: number;
  expectsScores: boolean;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const REWARM_DELAYS_MS = [2_000, 10_000, 30_000, 60_000, 300_000];

let worker: ChildProcess | undefined;
let state: EmbeddingWorkerState = "cold";
let rewarmTimer: ReturnType<typeof setTimeout> | undefined;
let rewarmAttempt = 0;
let warmInFlight: Promise<void> | undefined;
let stopping = false;
const pending = new Map<string, PendingRequest>();

export function embeddingWorkerState(): EmbeddingWorkerState {
  return state;
}

function localEmbeddingRequired(): boolean {
  const mode = (process.env.EMBEDDING_MODE || (process.env.OPENAI_API_KEY ? "openai" : "local")).toLowerCase();
  return mode === "local" || mode === "hybrid";
}

/** Overridable only so tests can exercise the IPC contract without a model. */
function workerEntry(): URL {
  const override = process.env.RETAINDB_EMBEDDING_WORKER_ENTRY;
  if (override) {
    return override.startsWith("file:") ? new URL(override) : pathToFileURL(resolve(override));
  }
  const source = import.meta.url.endsWith(".ts");
  return new URL(source ? "./workers/native-embedding-process.ts" : "./engine/workers/native-embedding-process.js", import.meta.url);
}

function loaderArguments(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    if (["--require", "--import", "--loader"].includes(process.execArgv[index])) {
      args.push(process.execArgv[index], process.execArgv[++index]);
    }
  }
  return args;
}

function settle(request: PendingRequest): void {
  pending.delete(request.id);
  clearTimeout(request.timer);
  if (request.signal && request.onAbort) request.signal.removeEventListener("abort", request.onAbort);
}

function rejectAll(error: Error): void {
  for (const request of [...pending.values()]) {
    settle(request);
    request.reject(error);
  }
}

function startWorker(): ChildProcess {
  if (worker && worker.exitCode === null && worker.signalCode === null) return worker;
  const entry = workerEntry();
  if (!entry.pathname.endsWith(".ts") && !existsSync(entry)) {
    state = "failed";
    throw new Error(`Embedding process entry is missing: ${entry.pathname}`);
  }
  const source = entry.pathname.endsWith(".ts");
  const child = fork(entry, [], {
    execArgv: source ? loaderArguments() : [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, RETAINDB_EMBEDDING_WORKER: "1", TSX_DISABLE_CACHE: "1" },
  });
  worker = child;
  child.unref();
  child.on("message", (message: unknown) => onMessage(child, message));
  child.on("error", (error) => failWorker(child, error));
  child.on("close", (code, signal) => {
    if (worker !== child) return;
    worker = undefined;
    failWorker(child, new Error(`Embedding process exited before completing the request (code ${code}, signal ${signal})`));
  });
  child.channel?.unref();
  return child;
}

function failWorker(child: ChildProcess, error: Error): void {
  rejectAll(error);
  state = "failed";
  if (worker === child) worker = undefined;
  if (stopping) return;
  child.kill("SIGKILL");
  scheduleRewarm();
}

function scheduleRewarm(): void {
  if (stopping || !localEmbeddingRequired() || rewarmTimer) return;
  const delay = REWARM_DELAYS_MS[Math.min(rewarmAttempt, REWARM_DELAYS_MS.length - 1)];
  rewarmAttempt++;
  rewarmTimer = setTimeout(() => {
    rewarmTimer = undefined;
    warmEmbeddings().catch(() => {});
  }, delay);
  rewarmTimer.unref?.();
}

function onMessage(child: ChildProcess, message: unknown): void {
  if (!message || typeof message !== "object" || !("id" in message)) return;
  const { id } = message as { id: unknown };
  if (typeof id !== "string") return;
  const request = pending.get(id);
  if (!request) return;
  if ("error" in message && typeof (message as { error: unknown }).error === "string") {
    settle(request);
    state = "failed";
    request.reject(new Error((message as { error: string }).error));
    return;
  }
  if (request.expectsScores) {
    const scores = (message as { scores?: unknown }).scores;
    if (!Array.isArray(scores) || scores.length !== request.expected || !scores.every(value => typeof value === "number" && Number.isFinite(value))) {
      settle(request);
      state = "failed";
      child.kill("SIGKILL");
      request.reject(new Error("Embedding process returned invalid scores"));
      return;
    }
    settle(request);
    state = "ready";
    rewarmAttempt = 0;
    request.resolve(scores);
    return;
  }
  const vectors = (message as { vectors?: unknown }).vectors;
  if (!Array.isArray(vectors) || vectors.length !== request.expected || !vectors.every(row =>
    Array.isArray(row) && row.length > 0 && row.every(value => typeof value === "number" && Number.isFinite(value)))) {
    settle(request);
    state = "failed";
    child.kill("SIGKILL");
    request.reject(new Error("Embedding process returned invalid vectors"));
    return;
  }
  settle(request);
  state = "ready";
  rewarmAttempt = 0;
  request.resolve(vectors);
}

function submit(message: Record<string, unknown>, expected: number, expectsScores: boolean, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<any> {
  if (process.env.RETAINDB_EMBEDDING_WORKER === "1") {
    return Promise.reject(new Error("The embedding worker cannot call itself"));
  }
  if (options.signal?.aborted) return Promise.reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("Embedding request aborted"));
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0 ? (options.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
  let child: ChildProcess;
  try {
    child = startWorker();
  } catch (error) {
    state = "failed";
    scheduleRewarm();
    return Promise.reject(error);
  }
  if (state !== "ready") state = "warming";
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const request: PendingRequest = {
      id, expected, expectsScores, resolve, reject, signal: options.signal,
      timer: setTimeout(() => {
        if (!pending.has(id)) return;
        settle(request);
        request.reject(new Error(`Embedding attempt timed out after ${timeoutMs}ms`));
        state = "failed";
        child.kill("SIGKILL");
        failWorker(child, new Error("Embedding process restarted after a timed-out request"));
      }, timeoutMs),
    };
    request.timer.unref?.();
    if (options.signal) {
      request.onAbort = () => {
        if (!pending.has(id)) return;
        settle(request);
        request.reject(options.signal!.reason instanceof Error ? options.signal!.reason : new Error("Embedding request aborted"));
      };
      options.signal.addEventListener("abort", request.onAbort, { once: true });
    }
    pending.set(id, request);
    child.send({ ...message, id }, error => {
      if (!error || !pending.has(id)) return;
      settle(request);
      reject(error);
      failWorker(child, error);
    });
  });
}

export function requestEmbeddings(texts: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<number[][]> {
  if (!texts.length) return Promise.resolve([]);
  return submit({ texts }, texts.length, false, options);
}

export function scoreInProcess(query: string, passages: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<number[]> {
  if (!passages.length) return Promise.resolve([]);
  return submit({ query, passages }, passages.length, true, options);
}

/** Warm the model once at startup so the first real search is not the one paying for loading. */
export function warmEmbeddings(): Promise<void> {
  if (!localEmbeddingRequired()) return Promise.resolve();
  if (warmInFlight) return warmInFlight;
  if (state === "ready") return Promise.resolve();
  state = "warming";
  warmInFlight = (async () => {
    try {
      await requestEmbeddings(["warmup"]);
      state = "ready";
      rewarmAttempt = 0;
    } catch (error) {
      state = "failed";
      scheduleRewarm();
      throw error;
    } finally {
      warmInFlight = undefined;
    }
  })();
  return warmInFlight;
}

export async function stopEmbeddingWorker(): Promise<void> {
  stopping = true;
  if (rewarmTimer) clearTimeout(rewarmTimer);
  rewarmTimer = undefined;
  const child = worker;
  worker = undefined;
  rejectAll(new Error("Embedding process stopped"));
  state = "cold";
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
    child.kill("SIGKILL");
  });
}

process.once("exit", () => { worker?.kill("SIGKILL"); });
