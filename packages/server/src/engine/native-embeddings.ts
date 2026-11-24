import { requestEmbeddings, stopEmbeddingWorker } from "./embedding-process.js";

/**
 * Native capture uses the same embedding process as recall: one model load,
 * one ONNX session, one queue. The API process only sends text and vectors.
 */
export function embedNativeCapture(texts: string[], remainingMs = 120_000): Promise<number[][]> {
  if (!texts.length) return Promise.resolve([]);
  const configured = Number(process.env.NATIVE_CAPTURE_EMBEDDING_TIMEOUT_MS || 120_000);
  const timeout = Math.max(1, Math.min(remainingMs, Number.isFinite(configured) ? Math.min(120_000, Math.max(100, configured)) : 120_000));
  // The deadline bounds receipt processing without releasing the ONNX slot prematurely.
  return requestEmbeddings(texts, { timeoutMs: timeout });
}

export async function stopNativeEmbeddingProcess(): Promise<void> {
  await stopEmbeddingWorker();
}
